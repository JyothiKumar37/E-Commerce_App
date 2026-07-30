/**
 * Signup/signin validation rules.
 *
 * The original schemas rejected valid input in ways real users would hit:
 * passwords containing a `#`, email addresses on any TLD other than
 * .com/.net/.de, and names written in a non-Latin script.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signInSchema, signUpSchema } from "../src/schemas.js";

const valid = {
  username: "adalovelace",
  email: "ada@example.com",
  password: "Analytical1!",
  first_name: "Ada",
  last_name: "Lovelace",
};

const check = (overrides = {}) => signUpSchema.validate({ ...valid, ...overrides });

describe("signUpSchema", () => {
  it("accepts a valid registration", () => {
    assert.equal(check().error, undefined);
  });

  describe("password", () => {
    it("accepts symbols outside the old @$!%*?& allowlist", () => {
      // `Password123#` was rejected by the original pattern despite being strong.
      for (const password of [
        "Password123#",
        "Password123^",
        "Correct1~Horse",
        "Aa1|batterystaple",
      ]) {
        assert.equal(check({ password }).error, undefined, `${password} should be accepted`);
      }
    });

    it("still requires each character class", () => {
      assert.match(check({ password: "alllowercase1!" }).error.message, /uppercase/);
      assert.match(check({ password: "ALLUPPERCASE1!" }).error.message, /lowercase/);
      assert.match(check({ password: "NoDigitsHere!!" }).error.message, /number/);
      assert.match(check({ password: "NoSymbolsHere1" }).error.message, /symbol/);
    });

    it("enforces a 10-character minimum", () => {
      assert.match(check({ password: "Short1!aa" }).error.message, /at least 10/);
    });

    it("allows a long passphrase", () => {
      const passphrase = `Correct-Horse-Battery-Staple-1!${"x".repeat(90)}`;
      assert.ok(passphrase.length <= 128);
      assert.equal(check({ password: passphrase }).error, undefined);
    });
  });

  describe("email", () => {
    it("accepts TLDs beyond .com/.net/.de", () => {
      for (const email of [
        "user@example.org",
        "user@example.io",
        "user@example.co.uk",
        "user@sub.example.dev",
      ]) {
        assert.equal(check({ email }).error, undefined, `${email} should be accepted`);
      }
    });

    it("lowercases and trims", () => {
      const { value } = check({ email: "  Ada@Example.COM  " });
      assert.equal(value.email, "ada@example.com");
    });

    it("rejects a malformed address", () => {
      assert.ok(check({ email: "not-an-email" }).error);
      assert.ok(check({ email: "missing@tld" }).error);
    });
  });

  describe("names", () => {
    it("accepts non-Latin scripts", () => {
      // The original regex enumerated Latin-1 accents only, silently excluding
      // most of the world.
      for (const name of ["Ада", "李", "محمد", "Θεοδώρα", "अनु"]) {
        assert.equal(check({ first_name: name }).error, undefined, `${name} should be accepted`);
      }
    });

    it("accepts hyphens, apostrophes and spaces", () => {
      for (const name of ["Anne-Marie", "O'Brien", "van der Berg", "St. John"]) {
        assert.equal(check({ last_name: name }).error, undefined, `${name} should be accepted`);
      }
    });

    it("rejects digits and control characters", () => {
      assert.ok(check({ first_name: "Ada2" }).error);
      assert.ok(check({ first_name: "<script>" }).error);
    });

    it("rejects an empty name", () => {
      assert.ok(check({ first_name: "" }).error);
    });
  });

  describe("username", () => {
    it("requires alphanumeric only", () => {
      assert.ok(check({ username: "ada lovelace" }).error);
      assert.ok(check({ username: "ada-lovelace" }).error);
    });

    it("enforces length bounds", () => {
      assert.ok(check({ username: "ab" }).error);
      assert.ok(check({ username: "a".repeat(31) }).error);
      assert.equal(check({ username: "a".repeat(30) }).error, undefined);
    });
  });
});

describe("signInSchema", () => {
  it("accepts an email and password", () => {
    const { error } = signInSchema.validate({ email: "ada@example.com", password: "anything" });
    assert.equal(error, undefined);
  });

  it("rejects a non-string password instead of letting bcrypt throw a 500", () => {
    // signIn previously had no validation at all, so `{ password: {} }` reached
    // bcrypt.compare and produced an unhandled 500.
    assert.ok(signInSchema.validate({ email: "ada@example.com", password: { $ne: null } }).error);
    assert.ok(signInSchema.validate({ email: "ada@example.com" }).error);
  });

  it("rejects a malformed email", () => {
    assert.ok(signInSchema.validate({ email: "nope", password: "x" }).error);
  });
});
