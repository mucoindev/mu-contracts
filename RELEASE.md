Live MU Gold pricing for MUV inventory sales.

LiveMuTreasury reads the existing MU Gold oracle for each quote and purchase, applies the controller discount, converts AVAX and BTC.b through their MU pool ratios, and enforces the buyer payment cap. Native overpayment is refunded. USDC is accounted in the same dollar unit as the ecosystem oracle.

The original MuTreasury source and artifacts remain available. This release prepares a separate wallet deployment; it does not change any deployed contract or move inventory.

Treasury validation: 24 passing tests, including live repricing, asset precision, native refunds, payment caps, access control and original treasury regressions.
