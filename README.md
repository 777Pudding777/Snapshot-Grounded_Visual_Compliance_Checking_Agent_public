# Snapshot-Grounded Visual Compliance Checking Agent
A modular TypeScript prototype for visual BIM compliance checking with vision-language models. The app loads IFC models, navigates the 3D scene, captures evidence snapshots, evaluates selected rules with configurable VLM providers, and stores traces/reports for later analysis.

## Features

- IFC model loading and viewing with That Open Components, Three.js, and Web-IFC.
- Rule-based compliance checks driven by a local visual rule library.
- VLM adapters for OpenRouter for local testing.
- Snapshot collection, navigation follow-ups, task-graph reasoning, and trace storage.
- HTML report generation and evaluation datasets for binary, conservative, and case-study runs.
- Optional Web Fetch worker for retrieving regulatory source material through an allowlisted proxy.

## Tech Stack

- TypeScript
- Vite
- Three.js
- That Open Components
- Web-IFC

## Getting Started

Before working with the viewer code, read the official That Open documentation:

- [That Open Docs](https://docs.thatopen.com/intro)
- [That Open GitHub organization](https://github.com/ThatOpen)

You would need to install
```bash
npm install @thatopen/components @thatopen/fragments @thatopen/ui three web-ifc
npm install -D vite typescript
```

The That Open docs introduce the BIM viewer stack and assume basic web development knowledge, including HTML, CSS, JavaScript/TypeScript, NPM, bundling, and Three.js.

### Prerequisites

- Node.js and NPM installed.
- Basic familiarity with Vite and TypeScript.
- Optional VLM provider credentials for OpenRouter.

### Install This Project

```bash
npm install
cp env.example .env
npm run dev
```

Then open the local Vite URL shown in the terminal.

For production builds:

```bash
npm run build
npm run preview
```

## Environment

The project reads Vite environment variables from `.env`. Start from `env.example` and configure only the providers you need:

- `VITE_OPENROUTER_API_KEY` for OpenRouter-backed VLM checks.
- `VITE_WEB_FETCH_PROXY_URL` for the optional regulatory fetch worker.
- `VITE_TAVILY_API_KEY` for optional regulatory search support.

## Project Structure

```text
.
|-- evaluation/
|   |-- configs/             # Model, rule-set, and run-setting configs
|   |-- reports/             # Generated HTML reports and JSON traces
|   `-- scenes/              # IFC/Revit scenes used for evaluation
|-- public/
|   |-- thatopen/            # Viewer worker assets
|   |-- web-ifc.wasm         # Web-IFC runtime
|   `-- web-ifc-mt.wasm      # Multi-threaded Web-IFC runtime
|-- scripts/                 # Utility scripts for model inspection
|-- src/
|   |-- config/              # Runtime settings, model lists, environment parsing
|   |-- data/                # Local compliance rule library
|   |-- modules/             # Compliance runner, agents, VLM logic, rule loading
|   |   `-- vlmAdapters/     # OpenRouter adapter, prompts, web tools
|   |-- reporting/           # HTML report generation
|   |-- storage/             # Browser-side persistence for rules, traces, snapshots
|   |-- types/               # Shared TypeScript domain types
|   |-- ui/                  # Panels, tree view, toast, inspection UI
|   |-- utils/               # Geometry and model ID helpers
|   |-- viewer/              # IFC viewer setup, API, state, upload, events
|   |-- main.ts              # Application bootstrap and module wiring
|   `-- styles.css           # Application styling
|-- env.example              # Example environment configuration
|-- index.html               # Vite entry HTML
|-- package.json             # Scripts and dependencies
`-- tsconfig.json            # TypeScript configuration
```

## Notes

- `evaluation/reports/` can contain large generated artifacts and is mainly useful for reproducing or reviewing experiments.
- `src/data/ruleLibrary.json` is the central rule source used by the application.
- VLM credentials can be supplied through `.env` or through the in-app provider configuration, depending on the workflow.


