const test = require("node:test");
const assert = require("node:assert/strict");

const { __test } = require("../src/web-server");

test("web options default to localhost with a generated token", () => {
  const options = __test.parseWebOptions([], {});

  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.port, 9173);
  assert.ok(options.token.length > 10);
});

test("web options accept env and CLI overrides", () => {
  const options = __test.parseWebOptions(
    ["--host", "0.0.0.0", "--port=9191", "--token", "cli-token"],
    {
      REMODEX_WEB_HOST: "127.0.0.2",
      REMODEX_WEB_PORT: "8888",
      REMODEX_WEB_TOKEN: "env-token",
    }
  );

  assert.equal(options.host, "0.0.0.0");
  assert.equal(options.port, 9191);
  assert.equal(options.token, "cli-token");
});

test("web local URL hides wildcard bind address and includes token", () => {
  const url = __test.buildLocalURL({
    host: "0.0.0.0",
    port: 9173,
    token: "secret",
  });

  assert.equal(url, "http://localhost:9173/?token=secret");
});

test("web options can disable token checks explicitly", () => {
  const options = __test.parseWebOptions(["--no-token"], {
    REMODEX_WEB_TOKEN: "env-token",
  });

  assert.equal(options.token, "");
});
