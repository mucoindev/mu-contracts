Direct MUO/MUV governance with vote-duration custody.

MuGovernor accepts the original MUO and MUV into member deposit accounting. It mints no governance receipt and requires no delegation. MUO has weight 1; MUV starts at 4. Only approved, timelocked DAO proposals may change the MUV multiplier or quorum policy. Each proposal retains the policy captured at creation.

Deposits are checkpointed before voting opens. Proposing and voting lock member deposits through the last participating proposal deadline. Withdrawals return the original tokens. Deposits remain separate from the spendable timelock treasury, and governance relay cannot approve or transfer voting tokens.

Validation: 28 ecosystem tests, including 18 direct-governance cases covering mixed weights, MUV-only proposals, inclusive deadlines, overlapping votes, withdrawal/redeposit recycling, multiplier and quorum changes during pending proposals, treasury execution, and reserve protection. Other ecosystem templates remain unchanged.

This source release replaces the undeployed DAO template. Application deployment and a wallet-signed governor deployment/registration are separate. Publishing this release performs no chain transaction and changes no existing token or treasury ownership.
