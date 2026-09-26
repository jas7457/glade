import { describe, expect, it } from "vitest";
import { readableError } from "../src/harness/provider-error.js";

describe("readableError", () => {
  it("extracts Anthropic error bodies with a status prefix", () => {
    const raw =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.1.image.source.base64: image exceeds 10 MB maximum: 11324160 bytes > 10485760 bytes"},"request_id":"req_011CX"}';
    expect(readableError(raw)).toEqual({ message: "Image exceeds 10 MB maximum (10.8 MB > 10 MB)", details: raw });
  });

  it("extracts OpenAI error bodies", () => {
    const raw =
      '429 {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}';
    expect(readableError(raw)).toEqual({
      message: "You exceeded your current quota, please check your plan and billing details.",
      details: raw,
    });
  });

  it("handles prefix text and Google-style array bodies", () => {
    const raw = 'Error: 400 [{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}]';
    expect(readableError(raw).message).toBe("API key not valid. Please pass a valid API key.");
  });

  it("handles a string error field and JSON nested in a message", () => {
    expect(readableError('{"error":"model not found"}').message).toBe("Model not found");
    expect(readableError('{"message":"upstream: 500 {\\"error\\":{\\"message\\":\\"boom\\"}}"}').message).toBe("Boom");
  });

  it("capitalizes plain text without adding details", () => {
    expect(readableError("fetch failed")).toEqual({ message: "Fetch failed" });
    expect(readableError("Connection error.")).toEqual({ message: "Connection error." });
  });

  it("keeps text with braces that aren't JSON", () => {
    expect(readableError("bad {thing}")).toEqual({ message: "Bad {thing}" });
  });
});
