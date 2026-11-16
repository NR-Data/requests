// Runs every request: issue opened (create/join/claim/handover/leave/takedown), /approve or /deny comments, daily sweep.
const fs = require("fs");
const path = require("path");

const ORG = "NR-Data";
const SELF = "requests";
const DAY = 86400000;
const TYPES = ["create", "join", "claim", "handover", "leave", "takedown"];
const FIELDS = { "Repository name": "repo", Game: "game", "New head maintainer": "new_head" };

// Issue forms render as "### Label\n\nvalue" sections
function parseForm(body) {
  const out = {};
  for (const part of (body || "").split(/^### /m).slice(1)) {
    const [label, ...rest] = part.split(/\r?\n/);
    const value = rest.join("\n").trim();
    const key = FIELDS[label.trim()];
    if (key) out[key] = value === "_No response_" ? "" : value.replace(/^@/, "").trim();
  }
  return out;
}

const validRepoName = (n) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(n) && !/\.git$/i.test(n) && n.toLowerCase() !== SELF;
const daysSince = (date, now = Date.now()) => (now - new Date(date).getTime()) / DAY;

const readme = (repo, game) => `# ${game} data

Army list data files for ${game}, made by the community.

> These files are made and maintained by the contributors of this repository. They are not made, maintained or endorsed by NewRecruit, and nobody here is affiliated with or endorsed by the publisher of ${game}. All game names and trademarks belong to their respective owners. You still need the official rules to play.

## Content rules

Data files hold facts: unit and option names, points, stat values, keywords, army building limits, page references. Never add rules, ability, spell or card text copied from books, cards, apps or websites (even retyped or lightly reworded), scans or screenshots, artwork or logos. Content reported by a rights holder is removed.

## How to contribute

- **Pull request:** fork this repository, make your changes and open a pull request.
- **Write access:** request it at https://nr-data.github.io/requests/
`;

module.exports = async function handle({ github, context, core }) {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));
  const self = { owner: ORG, repo: SELF };
  const isAdmin = (login) => cfg.admins.some((a) => a.toLowerCase() === login.toLowerCase());

  const say = (n, body) => github.rest.issues.createComment({ ...self, issue_number: n, body });
  const close = (n, reason = "completed") => github.rest.issues.update({ ...self, issue_number: n, state: "closed", state_reason: reason });
  const label = (n, l) => github.rest.issues.addLabels({ ...self, issue_number: n, labels: [l] });
  const reject = async (n, text) => { await say(n, text); await close(n, "not_planned"); };

  async function exists(repo) {
    try { await github.rest.repos.get({ owner: ORG, repo }); return true; } catch (e) { if (e.status === 404) return false; throw e; }
  }
  async function isCollaborator(repo, login) {
    try { await github.rest.repos.checkCollaborator({ owner: ORG, repo, username: login }); return true; } catch (e) { if (e.status === 404) return false; throw e; }
  }
  const addMaintainer = (repo, login) => github.rest.repos.addCollaborator({ owner: ORG, repo, username: login, permission: "maintain" });

  async function heads() {
    const { data } = await github.rest.repos.getContent({ ...self, path: "maintainers.json" });
    return { map: JSON.parse(Buffer.from(data.content, "base64").toString("utf8")), sha: data.sha };
  }
  // Retries on a sha conflict instead of a concurrency group, which would cancel queued requests
  async function setHead(repo, login, message) {
    for (let attempt = 0; ; attempt++) {
      const { map, sha } = await heads();
      if (login) map[repo] = login; else delete map[repo];
      const content = Buffer.from(JSON.stringify(map, Object.keys(map).sort(), 2) + "\n").toString("base64");
      try {
        await github.rest.repos.createOrUpdateFileContents({ ...self, path: "maintainers.json", message, content, sha });
        return;
      } catch (e) {
        if ((e.status !== 409 && e.status !== 422) || attempt >= 4) throw e;
      }
    }
  }

  // Active = committed, or opened/commented on an issue or PR, in this repository within inactiveDays
  async function isActive(repo, login) {
    const since = new Date(Date.now() - cfg.inactiveDays * DAY).toISOString();
    try {
      const { data } = await github.rest.repos.listCommits({ owner: ORG, repo, author: login, since, per_page: 1 });
      if (data.length) return true;
    } catch (e) {
      if (e.status !== 409) throw e; // empty repository
    }
    const { data } = await github.rest.search.issuesAndPullRequests({ q: `repo:${ORG}/${repo} involves:${login} updated:>=${since.slice(0, 10)}`, per_page: 1 });
    return data.total_count > 0;
  }

  async function doCreate(issue, f) {
    const author = issue.user.login;
    await github.rest.repos.createInOrg({
      org: ORG, name: f.repo, has_wiki: false,
      description: `${f.game} army list data. Community-made, not affiliated with NewRecruit or the game's publisher.`,
    });
    await github.rest.repos.createOrUpdateFileContents({
      owner: ORG, repo: f.repo, path: "README.md", message: "Create repository",
      content: Buffer.from(readme(f.repo, f.game)).toString("base64"),
    });
    await addMaintainer(f.repo, author);
    await setHead(f.repo, author, `Head maintainer of ${f.repo}: ${author}`);
    await say(issue.number, `Created https://github.com/${ORG}/${f.repo}. @${author}, you are its head maintainer: accept the invitation GitHub sent you to get write access.`);
    await close(issue.number);
  }

  async function doJoin(issue, repo, note = "") {
    const author = issue.user.login;
    await addMaintainer(repo, author);
    await say(issue.number, `${note}@${author}, you were invited to https://github.com/${ORG}/${repo}. Accept the invitation GitHub sent you to get write access.`);
    await close(issue.number);
  }

  async function onOpened(issue) {
    const type = issue.labels.map((l) => l.name).find((n) => TYPES.includes(n));
    if (!type) return;
    const f = parseForm(issue.body);
    const author = issue.user.login;
    const n = issue.number;
    if (type === "takedown") return say(n, `Thanks. An admin will look at this: ${cfg.admins.map((a) => "@" + a).join(" ")}`);

    if (!f.repo || !validRepoName(f.repo)) return reject(n, `\`${f.repo || ""}\` is not a valid repository name.`);
    if (type === "create") {
      if (!f.game) return reject(n, "Please give the name of the game.");
      if (await exists(f.repo)) return reject(n, `https://github.com/${ORG}/${f.repo} already exists. Open a join request instead.`);
      const since = new Date(Date.now() - 7 * DAY).toISOString();
      const { data: recent } = await github.rest.issues.listForRepo({ ...self, creator: author, labels: "create", state: "all", since, per_page: 100 });
      if (recent.filter((i) => i.number !== n && daysSince(i.created_at) < 7).length >= cfg.createsPerWeek) {
        return reject(n, `You can create at most ${cfg.createsPerWeek} repositories per week. Try again later.`);
      }
      const { data: user } = await github.rest.users.getByUsername({ username: author });
      if (cfg.createRequiresApproval || daysSince(user.created_at) < cfg.newAccountDays) {
        await label(n, "needs-approval");
        return say(n, `This needs an admin's approval. ${cfg.admins.map((a) => "@" + a).join(" ")}, reply \`/approve\` or \`/deny\`.`);
      }
      return doCreate(issue, f);
    }

    if (!(await exists(f.repo))) return reject(n, `There is no repository named \`${f.repo}\` in ${ORG}.`);
    const head = (await heads()).map[f.repo];

    if (type === "join") {
      if (await isCollaborator(f.repo, author)) return reject(n, `You already have access to ${f.repo}.`);
      if (!head || !(await isActive(f.repo, head))) return doJoin(issue, f.repo);
      await label(n, "awaiting-maintainer");
      return say(n, `@${head}, \`${author}\` would like to join ${f.repo}. Reply \`/approve\` or \`/deny\`. Without an answer it is approved automatically after ${cfg.approvalTimeoutDays} days.`);
    }
    if (type === "claim") {
      if (head && head.toLowerCase() === author.toLowerCase()) return reject(n, `You are already the head maintainer of ${f.repo}.`);
      if (head && (await isActive(f.repo, head))) return reject(n, `${f.repo} has an active head maintainer (\`${head}\`). Open a join request, or ask them to hand it over.`);
      if (!(await isCollaborator(f.repo, author))) await addMaintainer(f.repo, author);
      await setHead(f.repo, author, `Head maintainer of ${f.repo}: ${author}`);
      await say(n, `@${author}, you are now the head maintainer of https://github.com/${ORG}/${f.repo}. If you were not a collaborator yet, accept the invitation GitHub sent you.`);
      return close(n);
    }
    if (type === "handover") {
      if (!(head && head.toLowerCase() === author.toLowerCase()) && !isAdmin(author)) return reject(n, `Only the head maintainer of ${f.repo} can hand it over.`);
      if (!f.new_head) return reject(n, "Please give the new head maintainer's username.");
      try { await github.rest.users.getByUsername({ username: f.new_head }); } catch { return reject(n, `There is no GitHub user named \`${f.new_head}\`.`); }
      if (!(await isCollaborator(f.repo, f.new_head))) await addMaintainer(f.repo, f.new_head);
      await setHead(f.repo, f.new_head, `Head maintainer of ${f.repo}: ${f.new_head}`);
      await say(n, `\`${f.new_head}\` is now the head maintainer of https://github.com/${ORG}/${f.repo}.`);
      return close(n);
    }
    if (type === "leave") {
      await github.rest.repos.removeCollaborator({ owner: ORG, repo: f.repo, username: author });
      if (head && head.toLowerCase() === author.toLowerCase()) await setHead(f.repo, null, `${f.repo} has no head maintainer`);
      await say(n, `You no longer have access to ${f.repo}.`);
      return close(n);
    }
  }

  async function onComment(issue, comment) {
    const cmd = (comment.body.trim().match(/^\/(approve|deny)\b/i) || [])[1]?.toLowerCase();
    if (!cmd) return;
    const by = comment.user.login;
    const labels = issue.labels.map((l) => l.name);
    const f = parseForm(issue.body);
    let allowed = isAdmin(by);
    if (!allowed && labels.includes("awaiting-maintainer")) {
      const head = (await heads()).map[f.repo];
      allowed = !!head && head.toLowerCase() === by.toLowerCase();
    }
    if (!allowed || !(labels.includes("needs-approval") || labels.includes("awaiting-maintainer"))) return;
    if (cmd === "deny") return reject(issue.number, `Denied by \`${by}\`.`);
    if (labels.includes("needs-approval")) return doCreate(issue, f);
    return doJoin(issue, f.repo, `Approved by \`${by}\`. `);
  }

  async function sweep() {
    const pending = await github.paginate(github.rest.issues.listForRepo, { ...self, labels: "awaiting-maintainer", state: "open", per_page: 100 });
    for (const issue of pending) {
      const f = parseForm(issue.body);
      const head = (await heads()).map[f.repo];
      const timedOut = daysSince(issue.created_at) >= cfg.approvalTimeoutDays;
      if (!timedOut && head && (await isActive(f.repo, head))) continue;
      try {
        await doJoin(issue, f.repo, timedOut ? "No answer from the head maintainer, approved automatically. " : "The head maintainer is no longer active, approved automatically. ");
      } catch (e) {
        core.warning(`#${issue.number}: ${e.message}`);
      }
    }
  }

  const { eventName, payload } = context;
  if (eventName === "schedule" || eventName === "workflow_dispatch") return sweep();
  if (payload.issue.state !== "open") return;
  try {
    if (eventName === "issues") await onOpened(payload.issue);
    else if (eventName === "issue_comment") await onComment(payload.issue, payload.comment);
  } catch (e) {
    // The requester sees the failure instead of a silent issue
    await say(payload.issue.number, `Something went wrong handling this request: ${e.message}. An admin will take a look: ${cfg.admins.map((a) => "@" + a).join(" ")}`);
    throw e;
  }
};
module.exports.parseForm = parseForm;
module.exports.validRepoName = validRepoName;
module.exports.daysSince = daysSince;
