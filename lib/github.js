'use strict';

/** Saving state to the repo, and starting the next run, from inside a run. */

const { execSync } = require('child_process');

function git(args) {
  return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/** Commits and pushes state/ if it changed. Never throws: posting matters more. */
function commitState(message, log = console.log) {
  if (process.env.NO_GIT === 'true') return;
  try {
    git('add state');
    try {
      git('diff --cached --quiet');
      return; // nothing changed
    } catch {
      // there are changes
    }
    git(`commit -q -m ${JSON.stringify(message)}`);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        git('push -q');
        return;
      } catch (error) {
        if (attempt === 3) throw error;
        git('pull -q --rebase');
      }
    }
  } catch (error) {
    log(`::warning::Could not save state: ${String(error.message).split('\n')[0]}`);
  }
}

/** Starts a fresh run of the workflow in poster mode. */
async function dispatchContinuation(env = process.env, log = console.log) {
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!repo || !token) {
    log('::warning::No GITHUB_TOKEN; cannot start the next run. The schedule will start one.');
    return;
  }
  const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/post.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: env.GITHUB_REF_NAME || 'main', inputs: { daemon: 'true' } }),
  });
  if (!response.ok) {
    log(`::warning::Could not start the next run (HTTP ${response.status}). The schedule will start one.`);
  } else {
    log('Started the next run.');
  }
}

module.exports = { commitState, dispatchContinuation };
