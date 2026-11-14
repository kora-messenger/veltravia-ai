# Workspace credit allocation and the personal account agent (Step 62)

Two features that share one question: **who may spend which credit, and what did the assistant
actually do.**

Step 52 metered usage, Step 53 added the wallet, Steps 54 and 56 priced AI and integration work,
Step 57 put one coordinator in front of the lanes, Step 59 added limits and Steps 60 and 61 added
plans and payments. None of that could answer "give this project 5,000 of the workspace's credits
and nobody else". Step 62 adds that ceiling, and the tool layer that lets the assistant work inside
an account without inventing a second authorization model.

## 1. An allocation is a ceiling, not a balance

The wallet is still the only holder of credit, and the meter is still the only writer of a charge.
An allocation says: _this target may draw at most N credits from this workspace's pool, in this
lane._ Two consequences follow, and both are enforced rather than documented:

- Credit cannot be created here. `POST /api/allocations` moves nothing; it narrows what a run may
  draw. Spending still goes wallet -> meter -> charge.
- The two lanes are separate. `ai_tokens` and `integration_credits` have their own pool, their own
  allocations and their own totals. Nothing in the code adds one to the other, and no code path
  converts one into the other.

A workspace that never set a pool is reported as `pool.set: false`, not `total: 0`. Those mean
different things: "no ceiling was agreed" versus "the ceiling is zero and everything is refused".

## 2. Reservation is atomic

The billing coordinator (`apps/api/src/unified-billing.ts`) asks in this order:

1. the wallet, which can already refuse with `BILLING_INSUFFICIENT_CREDITS`;
2. the workspace allowance, which can refuse with `BILLING_ALLOCATION_EXHAUSTED`;
3. the credit lane's hold, which can still refuse for its own reasons.

The allowance is reserved _before_ the lane's hold, inside the allocation store's transaction, so
two concurrent runs cannot both be told there is room for the last of an allowance. Release paths
are explicit and each has a test or a documented reason:

| When                                         | What happens to the allowance                                          |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| The credit lane refuses after the hold       | released immediately                                                   |
| The operation settles for less than reserved | the spend is settled, the remainder released                           |
| The operation settles for more               | settles at the measured amount; the store decides cover                |
| The operation is cancelled or gives up       | released in full                                                       |
| The process dies mid-run                     | released by `POST /api/allocations/sweep` when the reservation expires |

Settlement and release failures are logged and swallowed: the wallet has already been charged by
then, and turning finished work into an error would be a worse answer than a reconcile note.

## 3. Policies

Eight policies are configurable per workspace and lane: `manual`, `equal`, `project`, `member`,
`priority`, `restricted`, `temporary`, `automatic`. `POST /api/allocations/distribute` applies one
to a named set of targets and reports `planned` and `applied` separately, so the screen can show
what a policy proposed before claiming it did it. `restricted` carries `allowedOperations`;
`temporary` carries `expiresAt`; `priority` funds the highest number first.

Platform-wide caps come from the environment (`VELTRAVIA_ALLOCATION_*`): maximum pool, maximum
single allocation, allocations per workspace and maximum share per target. They are ceilings on
what an operator can be asked for, and an ordinary member cannot raise them.

## 4. The personal account agent

`@veltravia/account-agent-core` declares the tools; `apps/api/src/account-agent-service.ts`
implements them over services that already exist. The design rule is that **the server decides
everything a model would otherwise have to be trusted with**:

- the owner comes from the authenticated request, never from an argument. An argument named
  `ownerRef`, `owner`, `email` or similar is refused with `IDENTITY_IN_ARGUMENTS`;
- a tool that needs a project or workspace looks it up and compares its owner, so a forged id is a
  plain "not found" instead of a reach into another account;
- risk decides the gate. Risk 1 is a read and runs. Risk 2 is a reversible write and runs under the
  caller's permission. Risk 3 asks for permission _and_ a confirmation. Risk 4 needs the workspace
  owner and a confirmation;
- a confirmation token is single-use and bound to the exact arguments: confirming 100 credits does
  not authorize 4,000 (`APPROVAL_INVALID`);
- `idempotencyKey` makes a repeated request a `replayed` answer rather than a second project;
- every call writes an append-only audit row with the tool, the outcome, the arguments after
  redaction and the changed resources.

### The tools

Reads (`account:read`): `account.summary`, `credits.balances`, `subscription.status`,
`billing.history`, `project.list`, `project.get`, `file.list`, `tasks.list`, `allocation.summary`,
`activity.list`, `account.search`.

Writes: `project.create` (2), `project.update` (2), `file.create_directory` (2), `workspace.rename`
(3, `workspace:admin`), `allocation.allocate` / `allocation.increase` / `allocation.reduce` (3,
`workspace:admin`), `project.delete` (4, `workspace:owner`).

Unavailable, with the reason returned to the caller: `member.invite` (no workspace membership in
this build), `integration.connect` (needs a person at an OAuth consent screen).

### Reaching the tools from the chat

`apps/api/src/account-tools.ts` declares the same operations in the platform's tool system, once per
owner, from the session that asked. Without it the account agent existed only behind
`/api/account/...`, so "how many credits have I got left" typed into the chat came back as prose.

What the tool system adds on the way in:

| account agent | in the chat                                                                               |
| ------------- | ----------------------------------------------------------------------------------------- |
| risk 1-2      | `low` / `medium`, runs when the owner asked                                               |
| risk 3        | `high`, `requiresConfirmation` - the person confirms against the exact arguments          |
| risk 4        | `critical`, the same, plus the owner check the account agent already made                 |
| refusal       | thrown as a tool failure, so the assistant cannot report it as done                       |
| confirmation  | passed as `grant: { kind: 'tool_confirmation', reference }` and recorded on the audit row |

The confirmation is deliberately not asked for twice: the chat's confirmation **is** the person's
decision, so the account layer accepts it, validates its shape, and stops there instead of raising a
second ticket nobody would see. `idempotencyKey` is the tool invocation id, so a retried tool call
cannot double a write.

Two limits are stated rather than worked around. A tool this build cannot perform is registered and
then disabled with its reason, which is how the assistant can name what is missing. A workspace-admin
operation is registered but ungranted on this surface, because a chat run has no workspace in scope,
so it reads as unavailable instead of acting on a guessed workspace.

## 5. Routes

```
GET    /api/allocations/capabilities
GET    /api/allocations?workspaceId=            summary: both lanes, pools, allocations
GET    /api/allocations/list                    allocations, filtered
GET    /api/allocations/history                 movements
GET/PUT /api/allocations/policy                 the workspace's default policy
PUT    /api/allocations/pool                    set the ceiling for one lane
POST   /api/allocations                         allocate to one target
POST   /api/allocations/distribute              apply a policy to many targets
POST   /api/allocations/:id/increase|reduce|reclaim|limit|priority|revoke
POST   /api/allocations/authorize|settle|release|sweep    the gate, exposed for inspection

GET    /api/account/catalog                     what the assistant may do here
POST   /api/account/actions                     one tool call
GET    /api/account/activity[/:entryId]         the trail
```

Every route takes the caller from the request context. A workspace id in a body narrows a look and
never widens access: the service resolves it through the Project Engine and answers
`404 ALLOCATION_NOT_FOUND` for a workspace that is not the caller's.

## 6. What is not delivered

- **No workspace membership.** There is one owner per account in this build, so "assign a member",
  "invite a team member" and member-scoped permission checks are honestly absent rather than
  simulated. The `member` target kind exists in the data model and is refused by the routes that
  would need a roster.
- **No credit purchase.** Allocations divide credit that already exists.
- **No operator console for allocations.** Administration is HTTP and the panel on `#/usage`.
- **The allocation sweep is on demand**, not scheduled.
- **No approval UI** beyond the confirmation the account agent returns in its own response.

## 7. Gotchas worth keeping

1. A project does not create a workspace. Fixtures must `POST /api/projects/:id/workspaces`, and
   the project response is flat (`{ id, workspaceId }`), not wrapped.
2. `EffectivePlan` carries `plan` (a plan definition), not `planId`. `BillingOverview` carries
   `paymentMethod` and `plan.currentPeriodEnd`, not `methods` or `subscription.periodEnd`.
3. The billing coordinator is built before the allocation service exists, so it receives a getter
   (`allocations: () => gateRef.current`) rather than the service. Passing the service directly
   creates a cycle in `server.ts`.
4. `AllocationSummaryCategory` nests its figures: `pool`, `totals`, `allocations`, `policy`. The
   client types mirror that shape; a client that flattens it will silently render zeros.
5. The web test harness has no `@testing-library/user-event` and no jest-dom matchers. Use
   `fireEvent` and plain truthiness (`toBeTruthy()`), and add `// @vitest-environment jsdom`.
