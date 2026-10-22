# Research notes

How other writing tools solve problems Qalam also has. **We learn techniques; we never copy code.**

| Note | Question it answers |
| --- | --- |
| [spellcheck.md](spellcheck.md) | Which engine and dictionaries to use for Arabic and English, measured, plus the plan |
| [grammarly.md](grammarly.md) | How Grammarly draws and maintains live underlines |
| [obsidian.md](obsidian.md) | How Obsidian (Electron) does spellcheck |

## Reproducing the REA runs

[REA](https://github.com/morluto/rea) 6.7.0, run through its CLI (the interactive `setup` is not needed):

```sh
# Obsidian: official release asar from github.com/obsidianmd/obsidian-releases
npx -y rea-agents@6.7.0 analyze-javascript-application /abs/path/obsidian-1.14.4.asar \
  --integrity-policy record-and-continue --json > analysis.jsonl

# Grammarly: the Chrome Web Store .crx, with the CRX3 header stripped, unzipped.
# The full extension exceeds REA's result budget, so analyse the highlighting files only.
npx -y rea-agents@6.7.0 analyze-javascript-application /abs/path/grammarly-subset \
  --integrity-policy record-and-continue --json > analysis.jsonl
```

The downloaded targets live outside the repo (`~/rea-targets/`) and are never committed.
