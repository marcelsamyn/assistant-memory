# Project Instructions

## Nitro Route Tree

- Never put tests, fixtures, mocks, or any Vitest imports under `src/routes`.
  Nitro treats files in that directory as runtime server entries, so a route-tree
  `.test.ts` file can be imported by the dev server and crash normal API
  requests. Keep route regression tests outside `src/routes` and import the
  route module from there instead.
