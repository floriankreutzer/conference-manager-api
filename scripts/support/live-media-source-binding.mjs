import { execFileSync } from 'node:child_process';
import { liveMediaFail, requireLiveMedia } from './live-media-operator-config.mjs';

// Both stages compare immutable commits. A PR-side ancestor is not an accepted
// main state; require the frozen source on the captured controller's first-parent
// history as well. No moving ref, user command, shell or network fetch is used.
export function assertLiveMediaSourceBinding({ sourceSha, controllerSha, expectedHead, repository }) {
  requireLiveMedia([sourceSha, controllerSha, expectedHead].every((value) => /^[a-f0-9]{40}$/.test(value || '')),
    'LIVE_MEDIA_SOURCE_INVALID');
  const git = (args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 256 * 1024 });
  try {
    requireLiveMedia(git(['rev-parse', 'HEAD']).trim() === expectedHead, 'LIVE_MEDIA_SOURCE_INVALID');
    git(['merge-base', '--is-ancestor', sourceSha, controllerSha]);
    const accepted = git(['rev-list', '--first-parent', '--max-count=4096', controllerSha]).trim().split('\n');
    requireLiveMedia(accepted.includes(sourceSha), 'LIVE_MEDIA_SOURCE_INVALID');
    return expectedHead;
  } catch { liveMediaFail('LIVE_MEDIA_SOURCE_INVALID'); }
}
