import { describe, expect, it } from "vitest";
import { scrubberFor } from "./attempts";
import { redact as redactFact } from "./capabilities";
import { FIRST_DRAFT, exportPreview } from "./exportChat";
import { redact as redactGatewayText } from "./gateways";
import { clean } from "./logs";
import type { Chat } from "./model";
import { findMarkdownSecrets, findSecrets, redactSecrets, redactValues } from "./secrets";
import type { SignInDetails } from "./tauriPipe";

// Discord's documented sample token, joined here so push protection doesn't take it for a live one.
const DISCORD_TOKEN = ["MTk4NjIyNDgzNDcxOTI1MjQ4", "Cl2FMQ", "ZnCjm1XVW7vRze4b7Cq4se7kKWs"].join(".");

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
    ["password in a link", "DATABASE_URL=postgres://app:Pa55w0rd!@db.internal:5432/app", "app:Pa55w0rd!"],
    ["password in a link", "pip install --index-url https://deploy:s3cr3t-T0ken@pypi.corp.lan/simple pkg", "deploy:s3cr3t-T0ken"],
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
    ["authorization header", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "Basic dXNlcjpwYXNzd29yZA=="],
    ["authorization header", '{"Proxy-Authorization": "Basic Zm9vOmJhcjEyMw=="}', "Basic Zm9vOmJhcjEyMw=="],
    ["cookie", "Cookie: hermes_session=s3cr3tcookie; theme=dark", "hermes_session=s3cr3tcookie; theme=dark"],
    ["password or key", "GET https://example.com/x?display_ticket=tkt456&y=1", "tkt456"],
    ["password in a link", "GET https://sk_live_abc123def456@example.com/x", "sk_live_abc123def456"],
    ["sign-in token (JWT)", "x-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig12345", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig12345"],
    ["bot token", "bot 12345:ABCDEFGHIJKLMNOPQRSTUVWX", "12345:ABCDEFGHIJKLMNOPQRSTUVWX"],
    ["bot token", `DISCORD=${DISCORD_TOKEN}`, DISCORD_TOKEN],
    ["password or key", "DJANGO_SECRET_KEY=django-insecure-abc123xyz", "django-insecure-abc123xyz"],
    ["password or key", "session_id=abc123def456", "abc123def456"],
    ["password or key", "a_b_c_d_e_f_g_h_i_j_password=Tr0ub4dor!3", "Tr0ub4dor!3"],
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
      ["u:pw-9x8y7z", text.indexOf("u:pw-9x8y7z")],
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
    "Set it in my_application_settings.base.DEFAULT_AUTO_FIELD_CONFIG, then restart.",
    "Cookie: theme=dark",
    "cookie = request.cookies.get('session')",
    "Authorization: you need a token for this one.",
    "curl -H 'Authorization: Basic $CREDS' https://api.example.com",
  ])("doesn't flag ordinary chat: %s", (text) => {
    expect(found(text)).toEqual([]);
  });

  // The export dialog scans every message when it opens; each of these runs took seconds at 40 KB (#490).
  it.each(["a-", "a_", "a_a-", "a.", "a+", "a.a.", "1:", "password-", "sk-", "eyJ-", "eyJaaaaaaaaa-", "eyJaaaaaaaaa."])("scans 40 KB of %s repeated in linear time", (run) => {
    const text = run.repeat(Math.ceil(40_000 / run.length));
    const t0 = performance.now();
    findSecrets(text);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it("still flags a password named after a long run of words, or in a link with a long scheme", () => {
    expect(found("a-b-c-d-e-f-g-h-i-j-k-l-db_password=Tr0ub4dor!3")).toEqual([["password or key", "Tr0ub4dor!3"]]);
    expect(found("postgresql+asyncpg://app:Pa55w0rd!@db.internal/app")).toEqual([["password in a link", "app:Pa55w0rd!"]]);
  });

  it("flags a password named inside a call that an outer name's value runs into", () => {
    expect(found('token = get_token(password="Tr0ub4dor!3")')).toEqual([["password or key", "Tr0ub4dor!3"]]);
    expect(found("token = get_token(password=Tr0ub4dor!3)")).toEqual([["password or key", "Tr0ub4dor!3"]]);
    expect(found("api_key = load(secret='s3cr3t-Value-42', retries=3)")).toEqual([["password or key", "s3cr3t-Value-42"]]);
  });
});

describe("Redacting secrets", () => {
  // Representative secret shapes, each with the part that must not survive.
  const seeded: [string, string][] = [
    ["Authorization: Bearer abcdefgh12345678secret", "abcdefgh12345678secret"],
    ['headers={"Authorization": "Basic dXNlcjpwYXNz"}', "dXNlcjpwYXNz"],
    ["sent Bearer eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl to the API", "c2lnbmF0dXJl"],
    ["Cookie: hermes_session=s3cr3tcookie; other=1", "s3cr3tcookie"],
    ["Set-Cookie: sid=abc123def; HttpOnly", "abc123def"],
    ["OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUv", "AbCdEfGhIjKlMnOpQrStUv"],
    ["using key sk-ant-api03-ZYXWVUTSRQPONMLKJIHG for anthropic", "ZYXWVUTSRQPONMLKJIHG"],
    ["openrouter sk-or-v1-0123456789abcdef0123", "0123456789abcdef0123"],
    ["token ghp_0123456789abcdefghijABCDEFGHIJ", "ghp_0123456789abcdefghijABCDEFGHIJ"],
    ["aws AKIAIOSFODNN7EXAMPLE in env", "AKIAIOSFODNN7EXAMPLE"],
    ["google AIzaSyA-0123456789abcdefghijklmnopqrstu", "AIzaSyA-0123456789abcdefghijklmnopqrstu"],
    ["telegram 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0 bot", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0"],
    ["slack xoxb-1234567890-abcdefghij", "xoxb-1234567890-abcdefghij"],
    ["hf hf_abcdefghijklmnopqrstuvwxyz", "hf_abcdefghijklmnopqrstuvwxyz"],
    ["GET https://user:hunter2@example.com/x", "hunter2"],
    ["GET https://sk_abcdef123456@example.com/x", "sk_abcdef123456"],
    ["GET https://example.com/x?auth=abc123&y=1", "abc123"],
    ["GET https://example.com/api/display/ws?display_ticket=tkt456", "tkt456"],
    ["GET https://user:p@ss@example.com/x", "ss@example"],
    ["ssh://liam:hunter2@hermes", "hunter2"],
    ['{"api_key": "plain-value-123", "model": "x"}', "plain-value-123"],
    ["password=hunter2 user=bob", "hunter2"],
    ["DISCORD_BOT_TOKEN: 'abc.def.ghi'", "abc.def.ghi"],
    ["client_secret=xyz789&grant=1", "xyz789"],
    ["-----BEGIN RSA PRIVATE KEY----- MIIEpAIBAAKCAQEA -----END RSA PRIVATE KEY-----", "MIIEpAIBAAKCAQEA"],
    ['Authorization: Digest username="alice", nonce="abc123", response="secretDigest"', "secretDigest"],
    ['{"headers": {"Authorization": "Digest username=\\"alice\\", response=\\"secretDigest\\""}}', "secretDigest"],
    ["Cookie: a=1; session=\"quoted\"; token=afterQuote", "afterQuote"],
    ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj"],
  ];
  it.each(seeded)("hides the secret in %s", (line, secret) => {
    const r = redactSecrets(line);
    expect(r.text).not.toContain(secret);
    expect(r.text).toContain("[redacted");
    expect(r.kinds.length).toBeGreaterThan(0);
  });

  it("keeps what isn't a secret, and doesn't redact twice", () => {
    expect(redactSecrets("2026-11-04 10:00:00 INFO agent: 1200 tokens used, max_tokens reached").text).toBe("2026-11-04 10:00:00 INFO agent: 1200 tokens used, max_tokens reached");
    expect(redactSecrets("Connection to ssh://liam@hermes is up").text).toBe("Connection to ssh://liam@hermes is up");
    expect(redactSecrets('h={"Authorization": "Basic dXNlcjpwYXNz", "Host": "x"}').text).toBe('h={"Authorization": [redacted], "Host": "x"}');
    const r = redactSecrets("Authorization: Bearer abcdefgh12345678");
    expect(r.text).toBe("Authorization: [redacted]");
    expect(r.kinds).toEqual(["authorization header"]);
    expect(redactSecrets("api_key=sk-proj-AbCdEfGhIjKlMnOpQrStUv").text).toBe("api_key=[redacted key]");
  });

  it("hides a password named inside a call that an outer name's value runs into, and all of a value with a bracket", () => {
    expect(redactSecrets('token = get_token(password="Tr0ub4dor!3")').text).toBe("token = [redacted][redacted])");
    expect(redactSecrets("token = get_token(password=Tr0ub4dor!3)").text).toBe("token = [redacted]");
    expect(redactSecrets("password=abc(def)").text).toBe("password=[redacted]");
  });
});

describe("Every surface hides what another hides", () => {
  const chat = (text: string): Chat => ({ id: "c", runtimeId: "rt", title: "Chat", source: "app", settled: false, updatedAt: 0, items: [{ kind: "user", id: "u", text }] });
  const sign: SignInDetails = { mode: "ssh", sshTarget: "", url: "", username: "liam", password: "Pw-hunter2-x", token: "tok_9f8e7d6c5b4a" };
  const EXPORT = "a chat export";
  const surfaces: [string, (text: string) => string][] = [
    ["Logs", (t) => clean(t).text],
    ["server facts", redactFact],
    ["gateway errors", (t) => redactGatewayText(t)],
    ["connection attempts", scrubberFor(sign)],
    [EXPORT, (t) => exportPreview(chat(t), FIRST_DRAFT, new Date(0)).text],
  ];
  // Each sample, and a part of its secret that must not survive anywhere.
  const samples: [string, string][] = [
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA"],
    ["Cookie: hermes_session=s3cr3tcookie9", "s3cr3tcookie9"],
    ["GET https://example.com/x?token=abc123def456&page=2", "abc123def456"],
    ["GET https://sk_live_abc123def456@example.com/x", "sk_live_abc123def456"],
    ["DATABASE_URL=postgres://app:Pa55w0rd!@db.internal:5432/app", "Pa55w0rd!"],
    ["sent Bearer 7f3a9c2e8b1d4f6a0e5c to the API", "7f3a9c2e8b1d4f6a0e5c"],
    ["x-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig12345abc", "eyJzdWIiOiIxIn0"],
    ["xeyJab-eyJhbGciOi.eyJzdWIiOiIx.c2ln", "eyJzdWIiOiIx"],
    ["using key sk-ant-api03-Zx8Kq2LmN4pR7tVw9yBc for anthropic", "Zx8Kq2LmN4pR7tVw9yBc"],
    ["bot 12345:ABCDEFGHIJKLMNOPQRSTUVWX", "ABCDEFGHIJKLMNOPQRSTUVWX"],
    [`DISCORD_BOT=${DISCORD_TOKEN}`, "ZnCjm1XVW7vRze4b7Cq4se7kKWs"],
    ["DJANGO_SECRET_KEY=django-insecure-abc123xyz", "abc123xyz"],
    ['body {\\"password\\": \\"hunter2xyz\\"}', "hunter2xyz"],
    ['password="ab\\"cd99" next', "cd99"],
    ["session_id=abc123def456", "abc123def456"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXk"],
  ];
  it.each(samples)("%s", (text, secret) => {
    for (const [name, hide] of surfaces) expect(hide(text), name).not.toContain(secret);
  });

  // A flag in a chat export redacts by default, so there a shape can turn down what reads as chat or code. These are the
  // ones the other surfaces hide and an export leaves to the owner.
  it.each([
    ["a line that is all base64, as a public key's or a certificate's body is", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj"],
    ["a named value too short or plain to tell from a word", "password=hunter"],
    ["an authorization header with more than a scheme and one credential", 'Authorization: Digest username="alice", response="secretDigest"'],
  ])("leaves %s in an export, and hides it elsewhere", (_, text) => {
    for (const [name, hide] of surfaces) {
      if (name === EXPORT) expect(hide(text), name).toContain(text);
      else expect(hide(text), name).not.toContain(text);
    }
  });
});

describe("Redacting known values", () => {
  it("leaves no part of a value that another value is inside, in any order", () => {
    for (const values of [["abcd", "xxabcdyy"], ["xxabcdyy", "abcd"]])
      expect(redactValues("xxabcdyy and abcd", values)).toEqual({ text: "[redacted] and [redacted]", places: 2 });
  });

  it("takes a short value only where no letter or digit is beside it, unless asked to take it anywhere", () => {
    expect(redactValues("abc_def xabc abc.", ["abc"]).text).toBe("[redacted]_def xabc [redacted].");
    expect(redactValues("abc_def xabc abc.", ["abc"], { anywhere: true }).text).toBe("[redacted]_def x[redacted] [redacted].");
  });

  it("takes the whole word around a value when asked", () => {
    expect(redactValues("host-ab1.example said (ab1)", ["ab1"], { word: true }).text).toBe("[redacted] said ([redacted])");
  });

  it("takes a long run of one value as a word in linear time, and still takes a value that runs past the word", () => {
    const run = "abcd".repeat(10_000);
    const t0 = performance.now();
    expect(redactValues(`x ${run} y`, ["abcd"], { word: true })).toEqual({ text: "x [redacted] y", places: 1 });
    expect(performance.now() - t0).toBeLessThan(100);
    expect(redactValues("pa:pa:pa end", ["pa:pa"], { word: true }).text).toBe("[redacted] end");
  });
});

describe("Flagging likely secrets in Markdown a reader decodes", () => {
  const key = "sk-ant-api03-Zx8Kq2LmN4pR7tVw9yBc";
  const written = (md: string) => findMarkdownSecrets(md).map((s) => md.slice(s.start, s.start + s.text.length));

  it("gives a secret spelled with escapes or references as written, wherever it is in the text", () => {
    for (const spelling of ["sk\\-ant\\-api03\\-Zx8Kq2LmN4pR7tVw9yBc", "sk-ant-api03-Zx8K&#x71;2LmN4pR7tVw9yBc", "sk&#45;ant-api03-Zx8Kq2LmN4pR7tVw9yBc"])
      for (const md of [spelling, `a\r\n\tb &lt; \\* ${spelling}\r\nend`, `[link](https://x.io/?k=${spelling})`, `\`${spelling}\``])
        expect(written(md)).toEqual([spelling]);
  });

  it("flags a secret written plainly once, and leaves other escapes and unknown references alone", () => {
    expect(written(`password=hunter\\2\\!x and ${key} &amp; \\*`)).toEqual(["hunter\\2\\!x", key]);
    expect(written("sk-ant-api03-Zx8K&bogus;q2LmN4pR7tVw9yBc")).toEqual([]);
  });
});
