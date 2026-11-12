// Publishes dist/ to the gh-pages branch of the GitHub repo.
// Usage: GH_TOKEN=... npm run build && npm run deploy
// The token is passed as an HTTP header for this one push only; it is never
// written to disk or to git config.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'https://github.com/ImraanSafla/SCROLL_AND_STITCH.git';
const token = process.env.GH_TOKEN;
if (!token) {
  console.error('Set GH_TOKEN to a GitHub token with write access to the repo.');
  process.exit(1);
}
const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
const dir = mkdtempSync(join(tmpdir(), 'sas-pages-'));
const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'inherit' });
try {
  cpSync('dist', dir, { recursive: true });
  writeFileSync(join(dir, '.nojekyll'), '');
  git('init', '-q', '-b', 'gh-pages');
  git('-c', 'user.name=Imraan', '-c', 'user.email=95957850+ImraanSafla@users.noreply.github.com',
    'add', '-A');
  git('-c', 'user.name=Imraan', '-c', 'user.email=95957850+ImraanSafla@users.noreply.github.com',
    'commit', '-q', '-m', `Deploy ${new Date().toISOString()}`);
  git('-c', `http.extraHeader=Authorization: Basic ${auth}`, 'push', '-q', '--force', REPO, 'gh-pages');
  console.log('Deployed to https://imraansafla.github.io/SCROLL_AND_STITCH/');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
