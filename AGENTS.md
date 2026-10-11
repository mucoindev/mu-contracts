# Contract repository rules

- This is the PUBLIC contract repository. Keep application/frontend/backend code,
  fixtures for the website, private planning documents, secrets and private Git
  history out of it. Never copy an application checkout or its .git directory.
- Export contract artifacts to `release/`; never write into a sibling application.
- Preserve deployed bytecode and its verification hashes when reorganizing files.
- Each package builds with its committed lockfile. Run its tests after changes.
  Update the release manifest deliberately and release only committed clean trees.
- Publishing a source release does not authorize any on-chain transaction.
- On Jon's workstation, follow the global agent bridge and workload governor rules.
  Use path-scoped commits. Check bridge claims before editing shared files.
