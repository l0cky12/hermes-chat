import { describe, expect, it } from "vitest";
import { findSecrets } from "./secrets";

const found = (text: string) => findSecrets(text).map((s) => [s.kind, s.text]);

describe("Flagging likely secrets", () => {
  it.each([
    ["API key", "export OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUv", "sk-proj-AbCdEfGhIjKlMnOpQrStUv"],
    ["API key", "I set anthropic to sk-ant-api03-Zx8Kq2LmN4pR7tVw9yBc and it still fails", "sk-ant-api03-Zx8Kq2LmN4pR7tVw9yBc"],
    ["API key", "git clone https://github.com/x/y with ghp_0123456789abcdefghijABCDEFGHIJ", "ghp_0123456789abcdefghijABCDEFGHIJ"],
    ["API key", "aws_access_key_id = AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
    ["API key", "HF_TOKEN=hf_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345", "hf_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345"],
    ["bearer token", "curl -H 'Authorization: Bearer 7f3a9c2e8b1d4f6a0e5c' https://api.example.com", "7f3a9c2e8b1d4f6a0e5c"],
    [
      "sign-in token (JWT)",
      "the cookie was eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U ok",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ],
    ["password in a link", "DATABASE_URL=postgres://app:Pa55w0rd!@db.internal:5432/app", "Pa55w0rd!"],
    ["password in a link", "pip install --index-url https://deploy:s3cr3t-T0ken@pypi.corp.lan/simple pkg", "s3cr3t-T0ken"],
    ["bot token", "TELEGRAM_BOT_TOKEN: 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ", "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ"],
    ["password or key", "ssh in with password: hunter2!", "hunter2!"],
    ["password or key", 'config = {"db_password": "Tr0ub4dor&3"}', "Tr0ub4dor&3"],
    ["password or key", "SECRET_KEY='django-insecure-k9#x2!m'", "django-insecure-k9#x2!m"],
    ["password or key", "admin_passphrase=correcthorsebatterystaple", "correcthorsebatterystaple"],
    ["password or key", 'password: "Tr0ub4dor.3"', "Tr0ub4dor.3"],
    ["password or key", '{"command": "PASSWORD=\\"Mov3rs!2026\\" ./deploy.sh"}', "Mov3rs!2026"],
    ["password or key", '{"env": "{\\"db_password\\": \\"Tr0ub4dor&3\\"}"}', "Tr0ub4dor&3"],
    ["password or key", '{"password": "Mov3rs!2026\\"SecretTail"}', 'Mov3rs!2026\\"SecretTail'],
    ["password or key", "secret='it\\'s-a-S3cret'", "it\\'s-a-S3cret"],
    ["password or key", '{"command": "PASSWORD=\\"C:\\\\keys\\\\Mov3rs!\\" run"}', "C:\\\\keys\\\\Mov3rs!"],
    ["password or key", '{"command": "PASSWORD=\\"say \\\\\\"hi\\\\\\" 9x\\" run"}', 'say \\\\\\"hi\\\\\\" 9x'],
    ["password or key", "password=C:\\Mov3rs!2026", "C:\\Mov3rs!2026"],
    ["bearer token", "Authorization: Bearer AbCdEfGhIjKlMnOpQrStUvWxYz", "AbCdEfGhIjKlMnOpQrStUvWxYz"],
    ["bearer token", '{"headers": {"Authorization": "Bearer AbCdEfGhIjKlMnOpQrStUvWxYz"}}', "AbCdEfGhIjKlMnOpQrStUvWxYz"],
  ])("flags a %s: %s", (kind, text, secret) => {
    expect(found(text)).toEqual([[kind, secret]]);
  });

  it("flags a private key whole, BEGIN to END, and a key cut off before its END", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn\n/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yP\n-----END RSA PRIVATE KEY-----";
    expect(found(`Here it is:\n\n${pem}\n\nThanks`)).toEqual([["private key", pem]]);
    expect(found("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC")).toEqual([
      ["private key", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC"],
    ]);
  });

  it("flags a private key written inside JSON, as a tool call's arguments are", () => {
    const args = JSON.stringify({ content: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\n" });
    expect(found(args)).toEqual([["private key", "-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaC1rZXk\\n-----END OPENSSH PRIVATE KEY-----"]]);
  });

  it("gives where each secret starts, in order, and flags a key inside a header once", () => {
    const text = "token=ghp_0123456789abcdefghijABCDEFGHIJ then https://u:pw-9x8y7z@h";
    expect(findSecrets(text).map((s) => [s.text, s.start])).toEqual([
      ["ghp_0123456789abcdefghijABCDEFGHIJ", 6],
      ["pw-9x8y7z", text.indexOf("pw-9x8y7z")],
    ]);
  });

  it.each([
    "Use a bearer token in the Authorization header.",
    "Bearer tokens expire after an hour.",
    "Bearer AuthenticationIsTheTopicHere is how the docs put it.",
    "Authorization: Bearer $GITHUB_TOKEN",
    "The password field is required.",
    "password: required",
    "Set token: 4096 as the limit, and max_tokens=8192.",
    "api_key = os.environ",
    'api_key = os.environ["OPENAI_API_KEY"]',
    "token = get_token()",
    "API_KEY=YOUR_API_KEY",
    "password=<password>",
    "DB_PASSWORD=${DB_PASSWORD}",
    "postgres://user:${PGPASSWORD}@db:5432/app",
    "postgres://user:****@db:5432/app",
    "https://user@example.com/path",
    "ssh git@github.com:org/repo.git",
    "pip install scikit-learn, and import sklearn as sk-learn",
    "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----",
    "-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIEAgAAuTANBgkqhkiG9w0B\n-----END CERTIFICATE-----",
    "Commit 9fceb02d0ae598e95dc970b74767f19372d61af8 fixed it; request 550e8400-e29b-41d4-a716-446655440000.",
    "secret: it's in the vault",
    "The sha256 is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.",
  ])("doesn't flag ordinary chat: %s", (text) => {
    expect(found(text)).toEqual([]);
  });

  // The export dialog scans every message when it opens; each of these runs took seconds at 40 KB (#490).
  it.each(["a-", "a.", "a+", "a.a.", "password-", "sk-", "eyJaaaaaaaaa-", "eyJaaaaaaaaa."])("scans 40 KB of %s repeated in linear time", (run) => {
    const text = run.repeat(Math.ceil(40_000 / run.length));
    const t0 = performance.now();
    findSecrets(text);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it("still flags a password named after a long run of words, or in a link with a long scheme", () => {
    expect(found("a-b-c-d-e-f-g-h-i-j-k-l-db_password=Tr0ub4dor!3")).toEqual([["password or key", "Tr0ub4dor!3"]]);
    expect(found("postgresql+asyncpg://app:Pa55w0rd!@db.internal/app")).toEqual([["password in a link", "Pa55w0rd!"]]);
  });
});
