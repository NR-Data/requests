// node scripts/handle.test.js
const assert = require("assert");
const { parseForm, validRepoName, daysSince } = require("./handle.js");

const body = "### Repository name\n\n@my-game\n\n### Game\n\nMy Game (2nd Edition)\n\n### Content rules\n\n- [X] This repository will not contain copyrighted content as described above.\n\n### What do you want to work on?\n\n_No response_";
assert.deepStrictEqual(parseForm(body), { repo: "my-game", game: "My Game (2nd Edition)" });
assert.deepStrictEqual(parseForm("### New head maintainer\r\n\r\n_No response_"), { new_head: "" });
assert.deepStrictEqual(parseForm(""), {});

assert(validRepoName("star-wars-legion"));
assert(validRepoName("The-9th-Age"));
assert(!validRepoName("requests"));
assert(!validRepoName("-bad"));
assert(!validRepoName("a/b"));
assert(!validRepoName("x.git"));
assert(!validRepoName(""));

assert.strictEqual(Math.round(daysSince("2026-01-01T00:00:00Z", Date.parse("2026-01-15T00:00:00Z"))), 14);
console.log("ok");
