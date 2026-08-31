/**
 * Unit tests for covenant-state derivation.
 *
 * The state is a priority reduction, so these assert the precedence: resolved
 * wins over expiry, expiry wins over share progress, and below expiry the count
 * selects reconstructable, collecting, or sealed. The chain-time guard (a null
 * clock, a zero expiry) is exercised so a covenant is never wrongly called
 * expired.
 */

import { describe, expect, test } from "vitest";
import { covenantState } from "#/core/covenant";

describe("covenantState", () => {
  test("resolved is `opened` regardless of the clock", () => {
    expect(
      covenantState({
        resolved: true,
        expiry: 1,
        k: 3,
        sharesPosted: 0,
        nowUnix: 9999,
      }),
    ).toBe("opened");
  });

  test("past expiry (unresolved) is `expired`", () => {
    expect(
      covenantState({
        resolved: false,
        expiry: 1000,
        k: 3,
        sharesPosted: 5,
        nowUnix: 2000,
      }),
    ).toBe("expired");
  });

  test("k reached below expiry is `reconstructable`", () => {
    expect(
      covenantState({
        resolved: false,
        expiry: 5000,
        k: 3,
        sharesPosted: 3,
        nowUnix: 1000,
      }),
    ).toBe("reconstructable");
  });

  test("some shares below k is `collecting`", () => {
    expect(
      covenantState({
        resolved: false,
        expiry: 5000,
        k: 3,
        sharesPosted: 1,
        nowUnix: 1000,
      }),
    ).toBe("collecting");
  });

  test("no shares is `sealed`", () => {
    expect(
      covenantState({
        resolved: false,
        expiry: 5000,
        k: 3,
        sharesPosted: 0,
        nowUnix: 1000,
      }),
    ).toBe("sealed");
  });

  test("a null clock never yields `expired`", () => {
    expect(
      covenantState({
        resolved: false,
        expiry: 1000,
        k: 3,
        sharesPosted: 0,
        nowUnix: null,
      }),
    ).toBe("sealed");
  });

  test("a zero expiry is not treated as elapsed", () => {
    expect(
      covenantState({
        resolved: false,
        expiry: 0,
        k: 2,
        sharesPosted: 2,
        nowUnix: 1000,
      }),
    ).toBe("reconstructable");
  });
});
