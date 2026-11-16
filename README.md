# NR-Data requests

Self-serve access for the NR-Data repositories: **https://nr-data.github.io/requests/**

Each request is an issue opened from that page. The `Requests` workflow handles it and replies on the issue:

| Request | What happens |
| --- | --- |
| Create | New repository, requester becomes head maintainer. Needs admin `/approve` when `createRequiresApproval` is on or the account is younger than `newAccountDays`. At most `createsPerWeek` per user. |
| Join | Immediate when the repository has no head maintainer, or theirs has been inactive for `inactiveDays`. Otherwise the head maintainer is asked (`/approve` or `/deny`), auto-approved after `approvalTimeoutDays`. |
| Claim | Become head maintainer of a repository with no head maintainer or an inactive one. |
| Hand over | Head maintainer (or admin) names a new head maintainer. |
| Leave | Removes your own access; a leaving head maintainer frees the repository for a claim. |
| Removal | Pings the admins. Never automated. |

Collaborators get the `maintain` role. Head maintainers are recorded in `maintainers.json`, settings live in `config.json`, admins can `/approve` or `/deny` anything.

## Setup (admins)

1. Create a GitHub App owned by NR-Data, webhook off, with repository permissions **Administration: write**, **Contents: write**, **Issues: write**, **Metadata: read**. Install it on all NR-Data repositories.
2. In this repository's settings: variable `APP_ID`, secret `APP_PRIVATE_KEY` (the App's private key).
3. Check: `node scripts/handle.test.js`.
