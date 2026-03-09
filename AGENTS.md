# Repository Guidelines

## Project Structure & Module Organization
This repository is a Vue 3 + TypeScript app packaged for Android with Capacitor.

- `src/`: main application code
- `src/views/`: route-level pages (for example `Home.vue`, `Backtest.vue`)
- `src/components/`: reusable UI components
- `src/stores/`: Pinia stores
- `src/api/` and `src/utils/`: data access and shared utilities
- `public/`: static assets and runtime config files
- `android/`: native Android project and Gradle build files
- `docs/`: user/developer docs
- `scripts/`: optional Python data service scripts

## Build, Test, and Development Commands
- `npm install`: install Node dependencies.
- `npm run dev`: start Vite dev server (`http://localhost:5173`).
- `npm run build`: run `vue-tsc` type-check + production build to `dist/`.
- `npm run preview`: preview the built web app locally.
- `npm run cap:sync`: rebuild web assets and sync them into `android/`.
- `cd android && ./gradlew assembleDebug`: build debug APK.
- `cd android && ./gradlew assembleRelease`: build release APK (requires signing setup).

## Coding Style & Naming Conventions
- Use TypeScript and Vue SFCs with 2-space indentation.
- Follow naming guidance from `docs/dev/contributing.md`.
- File names: lowercase/kebab-case where applicable.
- Vue component names: PascalCase.
- Variables/functions: camelCase.
- Constants: UPPER_SNAKE_CASE.
- Keep imports using the `@/` alias for `src/` when possible.
- Preserve the project’s structured comment style for non-trivial logic (for example `[WHY]`, `[WHAT]`).

## Testing Guidelines
No dedicated Jest/Vitest suite is currently configured. For each change:

- Run `npm run build` to catch type and build regressions.
- Manually verify affected views/routes in `npm run dev`.
- For Android-impacting changes, run `npm run cap:sync` and a debug APK build.

## Commit & Pull Request Guidelines
- Prefer Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, etc.
- Keep commits focused; avoid mixing refactors and feature work.
- PRs should include:
- clear summary of user-visible changes,
- linked issue(s) when applicable,
- verification steps you ran,
- screenshots/videos for UI changes.
