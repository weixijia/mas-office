# Set up the MAS Office kit in this folder

You are an AI assistant. Someone asked you to set up the **MAS Office kit** in the folder you have open. Explain what you are doing in one plain sentence per step.

## 1. Check the files

This folder should contain `AGENTS.md`, `harness/operations.md` and `office/index.html`. They are created by:

```
npx mas-office init --kit .
```

(or, from a clone of https://github.com/weixijia/mas-office: `node packages/node/bin/mas-office.js init --kit <this folder>`).

If any of the three files is missing, show the person that command, ask them to run it (or ask permission to run it yourself), and stop until the files exist. **Never overwrite or delete files that are already here.**

## 2. Continue as the Lead

Read `AGENTS.md` now and follow it from here on. Then run the **setup** operation (`harness/operations.md` → setup). It ends by telling the person to type `next`.
