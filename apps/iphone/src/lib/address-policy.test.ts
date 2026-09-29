import { describe, expect, it } from "vitest";
import { allowedAddresses, isAllowedAddress } from "./address-policy";

describe("isAllowedAddress", () => {
  it("allows https anywhere and http only to loopback", () => {
    expect(isAllowedAddress("https://mac.tail1234.ts.net")).toBe(true);
    expect(isAllowedAddress("http://127.0.0.1:62398")).toBe(true);
    expect(isAllowedAddress("http://localhost:4317")).toBe(true);
    expect(isAllowedAddress("http://[::1]:4317")).toBe(true);
    expect(isAllowedAddress("http://100.64.0.5:4317")).toBe(false);
    expect(isAllowedAddress("http://mac.tail1234.ts.net")).toBe(false);
    expect(isAllowedAddress("ftp://127.0.0.1")).toBe(false);
    expect(isAllowedAddress("not a url")).toBe(false);
  });

  it("filters a link's addresses in order", () => {
    expect(allowedAddresses(["http://192.168.1.2:4317", "https://b.ts.net", "http://127.0.0.1:1"])).toEqual(["https://b.ts.net", "http://127.0.0.1:1"]);
  });
});
