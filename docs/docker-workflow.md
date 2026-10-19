# Docker Development Workflow & Containerization Guide
**AI Proposals Obsidian Plugin (`ai-proposals`)**

Developing Obsidian plugins inside a containerized Docker environment guarantees absolute consistency across host operating systems and completely isolates host storage from development clutter.

---

## 1. Why Containerize Obsidian Development?

### 1.1 The Cloud Sync Dilemma (iCloud Drive / OneDrive)
Obsidian vaults frequently reside in cloud-synchronized folders (iCloud Drive, Microsoft OneDrive, Dropbox, Google Drive). 

When a standard Node.js development workflow is executed in such a directory:
1. `npm install` downloads **30,000 to 70,000 small files** into a local `node_modules` directory.
2. The cloud sync client (e.g. `iCloud Drive for Windows` or `OneDrive.exe`) attempts to inspect, hash, lock, and upload every single one of those files.
3. This triggers:
   - **Sync Thrashing**: CPU spikes to 100%, battery drain, and thermal throttling.
   - **Transient File Locks**: The cloud sync process locks files while esbuild tries to bundle, causing intermittent `EPERM` and `EBUSY` compile errors.
   - **Vault Synchronization Failures**: Cloud sync gets stuck in permanent "Syncing 42,109 items..." loops, preventing actual notes from syncing to mobile devices.

### 1.2 The Container Solution
Containerizing the toolchain with Docker completely eliminates this problem:
- `node_modules` lives strictly inside a Docker-managed named Linux volume.
- Only production build artifacts (`dist/main.js`, `dist/manifest.json`, `dist/styles.css`) are written to the host filesystem.
- Zero dependency pollution occurs on the host disk.

---

## 2. Named Volume Shadowing Architecture

### 2.1 The Docker Compose Setup
The container environment is governed by `Dockerfile` and `docker-compose.yml`:

```yaml
# docker-compose.yml
x-service-base: &service-base
  build:
    context: .
    dockerfile: Dockerfile
  image: ai-proposals-dev:latest
  volumes:
    - .:/app
    - ai-proposals-node-modules:/app/node_modules
  environment:
    - NODE_ENV=development

services:
  # Production build task (docker compose run --rm build)
  build:
    <<: *service-base
    profiles: ["cli"]
    environment:
      - NODE_ENV=production
    command: npm run build

  # Headless unit test task (docker compose run --rm test)
  test:
    <<: *service-base
    profiles: ["cli"]
    environment:
      - NODE_ENV=test
    command: npm run test

  # Incremental watch compiler (docker compose up watch)
  watch:
    <<: *service-base
    environment:
      - NODE_ENV=development
    command: npm run dev
    tty: true
    stdin_open: true

volumes:
  ai-proposals-node-modules:
    name: ai-proposals-node-modules
```

### 2.2 How Shadowing Works
Notice the volume mounts:
```yaml
  volumes:
    - .:/app
    - ai-proposals-node-modules:/app/node_modules
```

1. **Host Bind Mount (`.:/app`)**: Mounts the project root folder into the container at `/app`. Changes made on the host (e.g. editing `src/main.ts`) are instantly reflected inside the container.
2. **Named Volume Shadow Mount (`ai-proposals-node-modules:/app/node_modules`)**: 
   - In Linux VFS (Virtual File System), when a mount point is placed at a deeper directory path than a parent mount, the deeper mount **shadows** (overrides) the parent directory.
   - The named volume `ai-proposals-node-modules` is mounted directly over `/app/node_modules`.
   - Node.js dependency installations write exclusively into the Docker volume.
   - **Verification**: On the host machine in PowerShell, running `Test-Path .\node_modules` evaluates strictly to `False`.

---

## 3. Developer Automation CLI (`dev.ps1`)

To make container operations effortless without requiring developers to remember complex Docker commands, the project provides a PowerShell automation script: `dev.ps1`.

### 3.1 Command Reference Matrix

| Command | Action Performed | Docker / Tool Equivalent |
|---|---|---|
| `.\dev.ps1 build` | Compiles production bundle (`main.js`, `manifest.json`, `styles.css`) into `./dist/`. | `docker compose run --rm build` |
| `.\dev.ps1 test` | Executes Vitest headless unit tests inside container. | `docker compose run --rm test` |
| `.\dev.ps1 watch` | Launches real-time incremental watcher with auto-sync. | `docker compose up watch` |
| `.\dev.ps1 deploy` | Syncs `./dist/` to Obsidian vault & touches `.hotreload`. | PowerShell file sync to `.obsidian/plugins/` |
| `.\dev.ps1 clean` | Deletes local `./dist/` folder. | `Remove-Item -Recurse -Force dist` |
| `.\dev.ps1 clean -All` | Deletes `./dist/` AND drops Docker named volume. | `docker compose down -v --remove-orphans` |
| `.\dev.ps1 rebuild` | Rebuilds Docker image from scratch without cache. | `docker compose build --no-cache` |
| `.\dev.ps1 shell` | Opens interactive `/bin/sh` session inside container. | `docker compose run --rm build /bin/sh` |

### 3.2 Advanced CLI Options
- **`-DeployAfterBuild`**: Automatically copies artifacts to your Obsidian vault upon successful compilation:
  ```powershell
  .\dev.ps1 build -DeployAfterBuild
  ```
- **`-PluginDir <path>`**: Deploys the plugin to a custom vault location instead of the default relative vault path:
  ```powershell
  .\dev.ps1 deploy -PluginDir "C:\MyVault\.obsidian\plugins\ai-proposals"
  ```
- **Hot Reload Integration**: Whenever `deploy` runs, `dev.ps1` updates the timestamp of `.hotreload` in the target plugin directory. If the Obsidian [Hot Reload](https://github.com/pjeby/hot-reload) plugin is installed, Obsidian will immediately reload the plugin without restarting the app!

---

## 4. Continuous Integration & Deployment (CI/CD)

The GitHub Actions workflows mirror the Docker container environment, ensuring that code that compiles in Docker builds identically in CI.

### 4.1 Automated Validation (`.github/workflows/build.yml`)
Triggers on every pull request and push to `main`:
1. Checks out repository (`actions/checkout@v4`).
2. Provisions Node.js 20 LTS with npm cache (`actions/setup-node@v4`).
3. Runs `npm ci` for deterministic dependency installation.
4. Executes static type checking: `npm run typecheck` (`tsc --noEmit`).
5. Runs test suite: `npm run test` (Vitest).
6. Compiles production bundle: `npm run build` (esbuild).
7. Validates existence of artifacts: `dist/main.js` and `dist/manifest.json`.
8. Uploads build artifacts as pipeline attachments.

### 4.2 Automated Release Pipeline (`.github/workflows/release.yml`)
Triggers when a version tag is pushed (e.g. `git tag 1.0.0 && git push origin 1.0.0`):
1. Verifies that the Git tag matches the `"version"` field in `manifest.json`.
2. Compiles production bundle.
3. Generates cryptographic build attestation (`actions/attest-build-provenance@v2`).
4. Packages `main.js`, `manifest.json`, and `styles.css` into a GitHub Release using `gh release create`.

---

## 5. Troubleshooting & Container Debugging

### 5.1 Docker Daemon Not Responding
**Symptom**: `dev.ps1` reports `[ERROR] Docker is not installed or not in PATH.` or daemon connection timeouts.  
**Resolution**:
1. Open Docker Desktop.
2. Ensure Docker engine status displays **Engine running** (green indicator in the bottom-left corner).
3. In PowerShell, verify responsiveness:
   ```powershell
   docker info
   ```

### 5.2 Outdated Dependencies in Named Volume
**Symptom**: You added a new package to `package.json`, but `tsc` or `vitest` inside Docker reports missing types or modules.  
**Explanation**: Named volumes retain their state across container runs. A simple rebuild does not overwrite an existing volume.  
**Resolution**:
Purge the named volume and rebuild:
```powershell
.\dev.ps1 clean -All
.\dev.ps1 rebuild
.\dev.ps1 build
```

### 5.3 Transient File Locks on Windows
**Symptom**: `EPERM: operation not permitted` when copying files to `./dist/`.  
**Resolution**:
Cloud sync or antivirus software may temporarily lock `dist/main.js`. `dev.ps1` includes an automatic retry loop (`Cleanup-HostNodeModules`). If the issue persists, add `.projects/ai-proposals/dist` to Windows Defender exclusions.

### 5.4 Inspecting Container Internals
To inspect the virtual Linux filesystem, explore installed dependencies, or run ad-hoc scripts:
```powershell
.\dev.ps1 shell
```
Inside the container:
```sh
# Verify node_modules structure
ls -la /app/node_modules

# Run manual type check
npm run typecheck

# Exit container shell
exit
```
