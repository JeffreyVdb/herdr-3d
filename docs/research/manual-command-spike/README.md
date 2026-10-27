# Manual-command Herdr probe

Run on Linux with Python 3 and Herdr 0.9.1 installed:

```sh
python3 docs/research/manual-command-spike/probe.py --out docs/research/manual-command-spike/results.json
```

The probe creates a fresh named session and temporary configuration, adds a labelled sibling tab, sends synthetic hidden input through controller stdin, detaches, and checks tab/workspace closure against ordinary and detached child processes. It cleans up all recorded processes and deletes the session in `finally`. It depends on the adjacent `terminal-experience-spike/herdr-probe.py` stream helper.

It never runs sudo or Tailscale and never uses a real credential. `results.json` records the observed Herdr behavior, including the expected finding that a detached child survives closure. This is not a browser/SSH test or a production command runner. See [the investigation](../manual-agent-commands.md) for the proposed feature and remaining checks.
