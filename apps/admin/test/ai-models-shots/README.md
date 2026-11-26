# AI Models scorecard and cost preview screenshots (not part of CI)

Renders the real `AiModelsPanel` with a stubbed `fetch` (usage of the last 30 days, no runs): the
Evaluation tab's Scorecard (with usage, no calls yet, a failed read) and the save preview's monthly
cost estimate (two first models change; a failed usage read), at 1280, 768 and 375 px in light and
dark. The panel shell is not drawn. Run from `apps/admin`:

    VITE_PATH=<vite package folder> PLAYWRIGHT_PATH=<playwright package folder> \
      node test/ai-models-shots/run.mjs <out-dir>
