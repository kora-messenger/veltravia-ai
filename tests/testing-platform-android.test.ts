import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mobile = join(root, 'apps/mobile');
const android = join(mobile, 'android/app/src/main');
const res = join(android, 'res');

const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * The packaging configuration (Step 36).
 *
 * These are the decisions that cannot be checked by eye once an APK is on a
 * phone: which application id it installs under, whether cleartext traffic is
 * allowed, whether the icons exist, and - most important - whether any provider
 * credential could have been baked into the bundle. A wrong answer here is
 * invisible until a device is in someone's hand.
 */
describe('android project configuration', () => {
  it('wraps the real web build instead of a second frontend', () => {
    const config = read('apps/mobile/capacitor.config.ts');
    expect(config).toMatch(/appId:\s*'com\.veltravia\.ai'/);
    expect(config).toMatch(/appName:\s*'Veltravia AI'/);
    expect(config).toMatch(/webDir:\s*'\.\.\/web\/dist'/);
    expect(config).toMatch(/allowMixedContent:\s*false/);
    // The WebView must keep a secure origin.
    expect(config).toMatch(/androidScheme:\s*'https'/);
  });

  it('asks only for network access, and never plain http', () => {
    const manifest = readFileSync(join(android, 'AndroidManifest.xml'), 'utf8');
    expect(manifest).toMatch(/android\.permission\.INTERNET/);
    expect(manifest).toMatch(/android:usesCleartextTraffic="false"/);
    expect(manifest).toMatch(/android:allowBackup="false"/);
    // No camera, location, contacts or storage permission is requested.
    const permissions = manifest.match(/<uses-permission[^>]+>/g) ?? [];
    expect(permissions).toHaveLength(1);
  });

  it('brands the application and marks a testing build', () => {
    const strings = readFileSync(join(res, 'values/strings.xml'), 'utf8');
    expect(strings).toMatch(/<string name="app_name">Veltravia AI<\/string>/);
    const debugStrings = readFileSync(
      join(android, '../debug/res/values/strings.xml').replace('/main/../', '/'),
      'utf8',
    );
    expect(debugStrings).toMatch(/Veltravia AI \(test\)/);
  });

  it('ships the official logo at every launcher density', () => {
    for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
      const icon = join(res, `mipmap-${density}/ic_launcher.png`);
      expect(existsSync(icon), icon).toBe(true);
      expect(statSync(icon).size, icon).toBeGreaterThan(1000);
      const round = join(res, `mipmap-${density}/ic_launcher_round.png`);
      expect(existsSync(round), round).toBe(true);
      const foreground = join(res, `mipmap-${density}/ic_launcher_foreground.png`);
      expect(existsSync(foreground), foreground).toBe(true);
    }
    const adaptive = readFileSync(join(res, 'mipmap-anydpi-v26/ic_launcher.xml'), 'utf8');
    expect(adaptive).toMatch(/ic_launcher_background/);
    expect(adaptive).toMatch(/ic_launcher_foreground/);
  });

  it('uses the Veltravia navy for the icon and splash background', () => {
    const colors = readFileSync(join(res, 'values/ic_launcher_background.xml'), 'utf8');
    expect(colors).toMatch(/ic_launcher_background">#05060A/i);
    expect(colors).toMatch(/splash_background">#05060A/i);
    const splash = readFileSync(join(res, 'drawable/splash.xml'), 'utf8');
    expect(splash).toMatch(/@color\/splash_background/);
    expect(splash).toMatch(/@mipmap\/ic_launcher_foreground/);
  });

  it('installs a debug build beside a release one and labels it', () => {
    const gradle = read('apps/mobile/android/app/build.gradle');
    expect(gradle).toMatch(/applicationIdSuffix '\.debug'/);
    expect(gradle).toMatch(/versionNameSuffix '-test'/);
    // Version identity comes from the workflow so an APK traces to a commit.
    expect(gradle).toMatch(/VELTRAVIA_VERSION_NAME/);
    expect(gradle).toMatch(/VELTRAVIA_VERSION_CODE/);
  });

  it('signs the release only when a keystore is provided', () => {
    const gradle = read('apps/mobile/android/app/build.gradle');
    expect(gradle).toMatch(/if \(System\.getenv\('VELTRAVIA_KEYSTORE_PATH'\) != null\)/);
    expect(gradle).toMatch(/storePassword System\.getenv\('VELTRAVIA_KEYSTORE_PASSWORD'\)/);
    // A keystore or a password must never be committed.
    const keystores = readdirSync(mobile, { recursive: true, encoding: 'utf8' }).filter((entry) =>
      /\.(jks|keystore)$/i.test(entry),
    );
    expect(keystores).toEqual([]);
  });

  it('carries no provider credential in the packaged bundle', () => {
    const forbidden = [
      /sk-or-v1-[A-Za-z0-9]{8,}/,
      /sk-proj-[A-Za-z0-9]{8,}/,
      /gsk_[A-Za-z0-9]{8,}/,
      /OPENROUTER_API_KEY/,
      /OPENAI_API_KEY/,
      /GROQ_API_KEY/,
      /MISTRAL_API_KEY/,
      /VELTRAVIA_CREDENTIAL_KEY/,
    ];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(join(android, 'assets'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      if (!/\.(js|json|html|css|txt|xml)$/i.test(file)) continue;
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        expect(source, `${file} matched ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('publishes only a public backend URL, never a secret', () => {
    const config = JSON.parse(
      readFileSync(join(android, 'assets/public/runtime-config.json'), 'utf8'),
    );
    expect(Object.keys(config)).toEqual(['apiBaseUrl']);
    expect(typeof config.apiBaseUrl).toBe('string');
    expect(config.apiBaseUrl === '' || config.apiBaseUrl.startsWith('https://')).toBe(true);
  });
});

describe('the APK workflow', () => {
  const workflow = read('.github/workflows/android.yml');

  it('builds reproducibly from a clean checkout', () => {
    expect(workflow).toMatch(/actions\/checkout@v4/);
    expect(workflow).toMatch(/actions\/setup-node@v4/);
    expect(workflow).toMatch(/node-version: 20/);
    expect(workflow).toMatch(/npm ci/);
  });

  it('builds the real web application and syncs it', () => {
    expect(workflow).toMatch(/npm run build --workspace @veltravia\/web/);
    expect(workflow).toMatch(/npx cap sync android/);
  });

  it('sets up the Android build environment', () => {
    expect(workflow).toMatch(/actions\/setup-java@v4/);
    expect(workflow).toMatch(/java-version: '21'/);
    expect(workflow).toMatch(/android-actions\/setup-android@v3/);
  });

  it('builds both APKs and uploads them as artifacts', () => {
    expect(workflow).toMatch(/assembleDebug/);
    expect(workflow).toMatch(/assembleRelease/);
    expect(workflow).toMatch(/name: veltravia-ai-debug-apk/);
    expect(workflow).toMatch(/name: veltravia-ai-release-apk/);
    expect(workflow).toMatch(/if-no-files-found: error/);
  });

  it('keeps signing material in secrets and reports an unsigned release honestly', () => {
    expect(workflow).toMatch(/secrets\.ANDROID_KEYSTORE_BASE64/);
    expect(workflow).toMatch(/secrets\.ANDROID_KEYSTORE_PASSWORD/);
    expect(workflow).toMatch(/secrets\.ANDROID_KEY_ALIAS/);
    expect(workflow).toMatch(/secrets\.ANDROID_KEY_PASSWORD/);
    expect(workflow).toMatch(/UNSIGNED/);
    // The keystore is decoded into the runner's temp dir, never the workspace.
    expect(workflow).toMatch(/RUNNER_TEMP/);
  });

  it('never forwards a provider credential into the build', () => {
    for (const pattern of [
      /OPENROUTER_API_KEY/,
      /OPENAI_API_KEY/,
      /GROQ_API_KEY/,
      /MISTRAL_API_KEY/,
    ]) {
      expect(workflow).not.toMatch(pattern);
    }
  });

  it('never reads the secrets context from a step condition', () => {
    // GitHub rejects the entire workflow file when a step `if:` names `secrets`,
    // which silently turns the build into a run with zero jobs.
    const conditionalSecrets = workflow
      .split('\n')
      .filter((line) => /^\s+if:/.test(line) && /secrets\./.test(line));
    expect(conditionalSecrets).toEqual([]);
    // The secrets are read as step environment instead, which is allowed.
    expect(workflow).toMatch(/KEYSTORE_BASE64: \$\{\{ secrets\.ANDROID_KEYSTORE_BASE64 \}\}/);
  });

  it('fails the run when no APK was produced', () => {
    expect(workflow).toMatch(
      /if \[ -z "\$DEBUG_APK" \]; then echo "::error::No debug APK was produced"; exit 1; fi/,
    );
  });
});
