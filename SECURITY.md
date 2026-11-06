# Security policy

## Supported versions

MAS Office is pre-1.0. Security fixes land on `main` and in the next release of each package.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's [private vulnerability reporting](https://github.com/weixijia/mas-office/security/advisories/new). We aim to acknowledge reports within 5 working days and to agree a disclosure date with you.

## Scope and threat model

- The panel is a **read-only** viewer. It renders agent-written text (status lines, Markdown results, source cards) with its own escaping Markdown renderer and only allows `http(s):`, `mailto:` and relative links. An agent output that executes script in the panel is a vulnerability.
- `mas-office serve` is a **local development server**. It binds to `127.0.0.1` by default, serves files read-only from one workspace folder, refuses paths outside it, and only accepts event `POST`s with a JSON body. Exposing it to a network (`--host 0.0.0.0`) is at your own risk.
- The panel loads the `.js` data twins as `<script>` tags — from `file://` and from `mas-office serve` alike — so they run in the panel's page. Only open the panel on workspaces written by agents and tools you run yourself. `mas-office validate` parses twins statically and never executes them.
- `mas-office serve` sends a restrictive Content-Security-Policy for the panel, serves other agent-written workspace files sandboxed, and accepts only relative `?root=` paths.
