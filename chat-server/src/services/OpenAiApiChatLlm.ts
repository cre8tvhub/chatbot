/**
  @fileoverview This file contains the implementation of {@link ApiChatLlm} using the OpenAI ChatGPT API.
 */
import {
  OpenAIClient,
  GetChatCompletionsOptions,
  ChatMessage,
  ChatCompletions,
  FunctionDefinition,
} from "@azure/openai";
import { strict as assert } from "assert";
import { OpenAiChatMessage } from "./ChatLlm";
import { ApiChatLlm, ApiChatLlmAnswerAwaitedParams } from "./ApiChatLlm";
import { executeHttpApiRequest } from "./executeHttpApiRequest";
import { HttpApiCredentials, HttpRequestArgs } from "./HttpRequestArgs";
import { HttpVerb } from "chat-core";
import {
  PersistedFunctionDefinition,
  PersistedHttpRequestFunctionDefinition,
} from "./PersistedFunctionDefinition";
import yaml from "yaml";

/**
  Function called by ChatGPT API with associated metadata.
  Wraps the {@link FunctionDefinition} object from the OpenAI API.
 */
interface ChatGptLlmFunction {
  /**
        Function definition for LLM
      */
  persistedFunction: PersistedFunctionDefinition;
  /**
        Callable function that takes in the arguments from the LLM function call and returns the response.
        */
  function: (args: any) => Promise<unknown>;
  /**
        `true` if the function is loaded from the embedded content,
        and can be removed from the context window by calling the `clear_api_spec_actions` function.
        */
  dynamic?: boolean;
  /**
        Name of function. Same as the `definition.name` field.
        */
  name: string;
}

export type HttpEndpointLlmFunction = FunctionDefinition & {
  path: string;
  action: HttpVerb;
};

export type FindApiSpecFunctionDefinition = ({
  query,
}: {
  query: string;
}) => Promise<PersistedFunctionDefinition[]>;

interface OpenAiApiChatParams {
  /**
    OpenAI client
    */
  openAiClient: OpenAIClient;
  /**
    OpenAI ChatGPT API deployment name
    */
  deploymentName: string;
  /**
    System prompt personality
    @example
    "You are a friendly chatbot that can answer questions about the MongoDB Atlas API spec."
    */
  systemPromptPersonality: string;
  /**
    Function to find {@link FunctionDefinition} based on the API spec when the user asks you to perform an action.
    If none of the available functions match the user's query, use this function.
    */
  findApiSpecFunctionDefinition: ({
    query,
  }: {
    query: string;
  }) => Promise<PersistedFunctionDefinition[]>;
  /**
    Maximum number of dynamic actions to keep in the functions at a given time.
    @default 3
   */
  maxNumDynamicFunctions?: number;
}

export const baseOpenAiFunctionDefinitions: FunctionDefinition[] = [
  {
    name: "find_api_spec_action",
    description: "Find an action in the API spec",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "repeat the user's query" },
      },
      required: ["query"],
    },
  },
];

const makeFindApiSpecAction = (
  findApiSpecFunctionDefinition: FindApiSpecFunctionDefinition
) =>
  ({
    name: "find_api_spec_action",
    persistedFunction: {
      definition: {
        name: "find_api_spec_action",
        description: "Find an action in the API spec",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "repeat the user's query" },
          },
          required: ["query"],
        },
      },
    },
    function: findApiSpecFunctionDefinition,
  } satisfies ChatGptLlmFunction);

/**
    Constructs a LLM chatbot that can use an API spec to answer questions.
   */
export function makeOpenAiApiChatLlm({
  openAiClient,
  deploymentName,
  systemPromptPersonality,
  findApiSpecFunctionDefinition,
  maxNumDynamicFunctions = 3,
}: OpenAiApiChatParams): ApiChatLlm {
  // // SKUNK_TODO: we'll probably want to modify the system prompt.
  const baseSystemPrompt = `${systemPromptPersonality}
  Use the find_api_spec_action function to find an action in the API spec when the user asks you to perform an action.
  If none of the available functions match the user's query, use this function.
  Before performing an action, ask the user for any missing required parameters.
  Before performing a POST, DELETE, PUT, or PATCH function, ask the user to confirm that they want to perform the action.
  `;
  const baseFunctions: ChatGptLlmFunction[] = [
    makeFindApiSpecAction(findApiSpecFunctionDefinition),
  ];

  return {
    baseSystemPrompt,
    async answerAwaited({
      query,
      messages,
      options,
      staticHttpRequestArgs,
      apiCredentials,
    }: ApiChatLlmAnswerAwaitedParams) {
      // Construct the ChatGptLlmFunctions to use in the request from the available FunctionDefinitions.
      const availableLlmFunctions =
        makeAvailableLlmFunctionsFromFunctionDefinitions(
          messages[messages.length - 1].functions ?? [],
          baseFunctions,
          staticHttpRequestArgs ?? {},
          maxNumDynamicFunctions,
          apiCredentials
        );

      // Update the conversation with the new system prompt based on the current available functions
      let newMessages = updateConversationWithNewSystemPrompt({
        baseSystemPrompt,
        availableLlmFunctions,
        messages,
        query,
        staticHttpRequestArgs,
      });

      // Construct the LLM options, including the available functions
      const messageOptions: GetChatCompletionsOptions = {
        ...options,
        functions: availableLlmFunctions.map(
          (f) => f.persistedFunction.definition
        ),
        functionCall: "auto",
      };
      const messagesForOpenAi = newMessages.map(
        ({ content, role, name, functionCall }) => ({
          content,
          role,
          name,
          functionCall,
        })
      );

      // Get initial response from the LLM to the user's query.
      // The response can be one of the following:
      // - A text message to return to the user
      // - A function call to make
      const response = await openAiClient.getChatCompletions(
        deploymentName,
        messagesForOpenAi,
        messageOptions
      );
      const responseMessage = getChatMessageFromOpenAiResponse(response);

      // Enter this logic when the LLM has determined to make a function call.
      // We must:
      // 1. Process the function call
      // 2. Append relevant message(s) to the conversation based on the function call
      // 3. Update the functions available to the conversation.
      if (responseMessage.functionCall !== undefined) {
        const calledFunctionResponse = await handleOpenAiFunctionCall({
          responseMessage,
          availableLlmFunctions,
          newMessages,
        });
        newMessages = calledFunctionResponse.newMessages;
      } else {
        // If the LLM has not made a function call, we simply append the response message to the conversation.
        newMessages.push({
          ...(responseMessage as Omit<OpenAiChatMessage, "functions">),
          functions: availableLlmFunctions.map((f) => f.persistedFunction),
        });
      }
      return {
        newMessages,
      };
    },
  };
}

/**
  Helper function to make available {@link ChatGptLlmFunction} objects from {@link PersistedFunctionDefinition} objects.
 */
function makeAvailableLlmFunctionsFromFunctionDefinitions(
  functionDefinitions: PersistedFunctionDefinition[],
  baseLlmFunctions: ChatGptLlmFunction[],
  staticHttpRequestArgs: HttpRequestArgs,
  maxNumDynamicFunctions: number,
  apiCredentials: HttpApiCredentials
): ChatGptLlmFunction[] {
  const availableFunctionDefinitions = getMaxAvailableFunctionDefinitions(
    functionDefinitions,
    baseLlmFunctions.map((f) => f.persistedFunction),
    maxNumDynamicFunctions
  );
  const availableChatGptFunctions = availableFunctionDefinitions.map(
    (functionDefinition) => {
      const baseLlmFunction = baseLlmFunctions.find(
        (baseFunction) =>
          baseFunction.name === functionDefinition.definition.name
      );
      if (baseLlmFunction) {
        return baseLlmFunction;
      } else {
        return makeDynamicHttpLlmFunctionFromFunctionDefinition(
          functionDefinition as PersistedHttpRequestFunctionDefinition,
          staticHttpRequestArgs,
          apiCredentials
        );
      }
    }
  );
  return availableChatGptFunctions;
}

/**
  Helper function to only get the max number of available dynamic {@link PersistedFunctionDefinition} objects.
  Filters out the older dynamic {@link PersistedFunctionDefinition} objects.
  Returns a new array, so we can mutate the array without side effect risk.
 */
function getMaxAvailableFunctionDefinitions(
  availableFunctionDefinitions: PersistedFunctionDefinition[],
  baseFunctionDefinitions: PersistedFunctionDefinition[],
  maxNumDynamicFunctions: number
) {
  const uniqueFunctionNames = new Set<string>();
  const availableFunctionsCopy = [
    ...baseFunctionDefinitions,
    ...availableFunctionDefinitions,
  ].filter((fxn) => {
    if (uniqueFunctionNames.has(fxn.definition.name)) {
      return false;
    }
    uniqueFunctionNames.add(fxn.definition.name);
    return true;
  });
  if (availableFunctionDefinitions.length > maxNumDynamicFunctions) {
    let counter = 0;
    return availableFunctionsCopy
      .reverse()
      .filter((llmFunc) => {
        let toInclude = false;
        if (
          counter <= maxNumDynamicFunctions ||
          !baseFunctionDefinitions.find(
            (baseFunc) => baseFunc.definition.name === llmFunc.definition.name
          )
        ) {
          toInclude = true;
        }
        ++counter;
        return toInclude;
      })
      .reverse();
  }
  return availableFunctionsCopy;
}

/**
  Helper function to make a dynamic {@link ChatGptLlmFunction} from a {@link PersistedFunctionDefinition}
 */
function makeDynamicHttpLlmFunctionFromFunctionDefinition(
  persistedFunctionDefinition: PersistedHttpRequestFunctionDefinition,
  staticHttpRequestArgs: HttpRequestArgs,
  apiCredentials: HttpApiCredentials
): ChatGptLlmFunction {
  return {
    name: persistedFunctionDefinition.definition.name,
    persistedFunction: persistedFunctionDefinition,
    function: async (dynamicHttpRequestArgs: HttpRequestArgs) => {
      const { httpVerb, path: resourcePath } = persistedFunctionDefinition;
      return await executeHttpApiRequest({
        httpVerb,
        resourcePath,
        staticHttpRequestArgs: staticHttpRequestArgs,
        dynamicHttpRequestArgs,
        apiCredentials,
      });
    },
    dynamic: true,
  };
}

/**
  Helper function to get chat messages from the ChatGPT API response {@link ChatCompletions} object.
 */
function getChatMessageFromOpenAiResponse(
  chatChatCompletions: ChatCompletions
): ChatMessage {
  const { choices } = chatChatCompletions;
  if (choices[0] === undefined || choices[0].message === undefined) {
    throw new Error("No message returned from OpenAI API");
  }
  return choices[0].message;
}

/**
  Helper function to rebuild the conversation with the updated system prompt.
 */
function updateConversationWithNewSystemPrompt({
  baseSystemPrompt,
  availableLlmFunctions,
  messages,
  query,
  staticHttpRequestArgs,
}: {
  baseSystemPrompt: string;
  availableLlmFunctions: ChatGptLlmFunction[];
  messages: OpenAiChatMessage[];
  query?: string;
  staticHttpRequestArgs?: HttpRequestArgs;
}) {
  const currentMessages = [
    {
      role: "system",
      content: makeSystemPrompt(
        baseSystemPrompt,
        availableLlmFunctions,
        staticHttpRequestArgs
      ),
    },
    ...messages.filter((message) => message.role !== "system"),
  ] satisfies OpenAiChatMessage[];
  if (query) {
    currentMessages.push({
      role: "user",
      content: query,
    });
  }
  return currentMessages;
}

/**
  Construct system prompt for the LLM on each request.
  This helps the LLM know what to do with the dynamically added functions.
  @param baseSystemPrompt - System prompt for all LLM requests. Includes the personality and general instructions.
  @param currentFunctions - Information about additional functions available for the LLM to call.
  @returns string - the system prompt for the LLM
 */
export function makeSystemPrompt(
  baseSystemPrompt: string,
  currentFunctions: ChatGptLlmFunction[],
  staticHttpRequestArgs?: HttpRequestArgs
) {
  const dynamicFuncs = currentFunctions.filter((f) => f.dynamic);
  let systemPrompt = baseSystemPrompt;
  if (dynamicFuncs.length > 0) {
    systemPrompt =
      baseSystemPrompt +
      `Call the functions ${dynamicFuncs
        .map((func) => func.persistedFunction.definition.name)
        .join(
          ", "
        )} only when you have all necessary parameters to complete the action.
If you don't yet have all the necessary information, continue asking the user for more information until you have it all.
If you have the necessary information, call the function and then append the function's response to the conversation.`;
  }
  if (staticHttpRequestArgs) {
    systemPrompt += "\n" + makeUserSystemPromptContext(staticHttpRequestArgs);
  }
  return systemPrompt;
}

/**
  Add HTTP request specific information to the system prompt,
  as provided by the user before the conversation started.
  */
function makeUserSystemPromptContext(
  staticHttpRequestArgs: HttpRequestArgs
): string {
  return `The following information is available for you to use for calling functions:
${
  staticHttpRequestArgs.headers
    ? "Headers:\n" + yaml.stringify(staticHttpRequestArgs.headers).trim() + "\n"
    : ""
}${
    staticHttpRequestArgs.body
      ? "Request body:\n" +
        yaml.stringify(staticHttpRequestArgs.body).trim() +
        "\n"
      : ""
  }${
    staticHttpRequestArgs.pathParameters
      ? "Path parameters:\n" +
        yaml.stringify(staticHttpRequestArgs.pathParameters).trim() +
        "\n"
      : ""
  }${
    staticHttpRequestArgs.queryParameters
      ? "Query parameters:\n" +
        yaml.stringify(staticHttpRequestArgs.queryParameters).trim() +
        "\n"
      : ""
  }
  `.trimEnd();
}

/**
  Helper function to handle the LLM's function call.

  Chooses between the following function actions:

  - Make a call to one of the dynamic functions, which calls the relevant API endpoint
    and then appends the "function" message to the conversation.
  - Make a call to the find_api_spec_action function, which performs vector search
    to add the relevant API action to the set of available options.
 */
async function handleOpenAiFunctionCall({
  responseMessage,
  availableLlmFunctions,
  newMessages,
}: {
  responseMessage: ChatMessage;
  availableLlmFunctions: ChatGptLlmFunction[];
  newMessages: OpenAiChatMessage[];
}) {
  assert(
    responseMessage.functionCall,
    "No function call returned from OpenAI. This function should only be called if it's validated that the response message has the `functionCall` property."
  );
  const { name } = responseMessage.functionCall;
  const functionToCall = availableLlmFunctions.find(
    (f) => f.persistedFunction.definition.name === name
  );
  // The LLM has chosen one of the dynamic functions.
  if (functionToCall && functionToCall.dynamic) {
    // Call dynamic function (i.e make the API call)
    const functionResponse = await functionToCall.function(
      responseMessage.functionCall.arguments
    );

    newMessages.push(responseMessage as OpenAiChatMessage, {
      role: "function",
      name: functionToCall.name,
      content:
        typeof functionResponse === "string"
          ? functionResponse
          : JSON.stringify(functionResponse),
      functions: availableLlmFunctions.map((f) => f.persistedFunction),
    });
  }
  // The LLM has chosen to find action(s) in the API spec.
  // We add the action(s) to the set of available functions.
  else if (functionToCall && functionToCall.name === "find_api_spec_action") {
    // Call function to find relevant action(s) in the API spec
    // and add them to the set of available actions
    const apiSpecActions = (await functionToCall.function(
      JSON.parse(responseMessage.functionCall.arguments)
    )) as PersistedFunctionDefinition[];
    // const previousMessage = newMessages[newMessages.length - 1];

    newMessages.push(responseMessage as OpenAiChatMessage, {
      role: "function",
      name: functionToCall.name,
      content: apiSpecActions.length
        ? `Found the following function(s) to use:
- ${apiSpecActions.map((axn) => axn.definition.name).join("\n- ")}

They have been added to your set of available functions. Execute the function if you have sufficient data. If you need more data, ask the user for it.`
        : `No function found in the API spec. Try asking the user for more information.`,
      functions: [
        ...availableLlmFunctions.map((fxn) => fxn.persistedFunction),
        ...apiSpecActions,
      ],
    });
  }
  return {
    newMessages,
  };
}
