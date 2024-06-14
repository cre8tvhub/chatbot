import { ObjectId } from "mongodb-rag-core";
import { GenerateDataFunc } from "../generate/GenerateDataFunc";
import { SomeGeneratedData } from "../generate/GeneratedDataStore";
import { TRIGGER_SERVER_ERROR_MESSAGE } from "./mockExpressApp";
import { strict as assert } from "assert";
import { isConversationTestCase, SomeTestCase } from "../generate/TestCase";
import { Message } from "mongodb-chatbot-server";

export const mockGenerateDataFunc: GenerateDataFunc = async ({
  runId,
  testCases,
}) => {
  const failedCases: SomeTestCase[] = [];
  const generatedData: SomeGeneratedData[] = testCases
    .filter((testCase) => isConversationTestCase(testCase))
    .filter((testCase) => {
      assert(Array.isArray(testCase.data.messages), "something is wrong here");
      const isFailed =
        testCase.data.messages[0].content === TRIGGER_SERVER_ERROR_MESSAGE;
      if (isFailed) {
        failedCases.push(testCase);
      }
      return !isFailed;
    })
    .map((testCase) => ({
      _id: new ObjectId(),
      commandRunId: runId,
      type: "conversation",
      data: {
        messages: [
          ...(testCase.data.messages as Message[]),
          {
            content: "This is a test message",
            role: "assistant",
          },
        ] as Message[],
      },
    }));
  return {
    generatedData,
    failedCases,
  };
};
