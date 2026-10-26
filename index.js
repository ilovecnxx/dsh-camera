/**
 * dsh-camera — Host half.
 *
 * Flow: the Web client arms one conversation through the `/dsh-camera` RPC
 * channel, receives a QR code and a LAN URL, and the phone opens that URL,
 * takes a photo, and uploads it. The Host stores the link in a small token
 * store, serves a self-contained mobile page on the LAN from its own HTTP
 * server (the DSH Web server itself only listens on loopback), and injects each
 * upload into the armed conversation as one user message carrying image
 * attachments.
 *
 * The plugin imports only Node built-ins and its own relative modules: it is
 * installed as a `link:` package, so no `@deepseek-ai/*` import would resolve
 * from its own directory.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveConfig } from './lib/config.js';
import { createInjector } from './lib/inject.js';
import { installRpc } from './lib/rpc.js';
import { startCameraServer } from './lib/server.js';
import { TokenStore } from './lib/tokens.js';

/** Stable Cordis plugin name. */
export const name = 'dsh-camera';

/**
 * Required Host services: `webServer` hosts the panel's RPC prefix route,
 * `connection` owns browser authentication, and `sessionController` owns prompt
 * admission for the target Session.
 */
export const inject = ['webServer', 'connection', 'sessionController', 'attachments', 'fileUploads'];

/** Interval for pruning expired tokens from the persisted store. */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Read the installed plugin version without an import assertion.
 * @returns {string} package version.
 */
function packageVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Compose the Host half.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {Record<string, unknown> | undefined} rawConfig - profile row config.
 * @returns {Promise<() => Promise<void>>} disposer that stops the LAN server and detaches effects.
 */
export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const log = ctx.logger('dsh-camera');
  const version = packageVersion();

  /** Mutable runtime state shared with the RPC handlers. */
  const state = {
    /** @type {object | null} */
    server: null,
    /** @type {string | null} */
    serverError: null,
    /** @type {ReturnType<typeof installRpc> | null} */
    rpc: null,
  };

  const tokens = new TokenStore({
    file: path.join(config.stateDir, 'state.json'),
    ttlMs: config.tokenTtlMs,
    maxTokens: 16,
  });
  try {
    await tokens.load();
  } catch (error) {
    log.warn('dsh-camera: token store could not be loaded (%s); starting empty', error?.message ?? error);
  }

  const injector = createInjector({ ctx, config, log });

  if (config.enabled) {
    try {
      state.server = await startCameraServer({
        config,
        tokens,
        injector,
        log,
        version,
      });
      log.info(
        'dsh-camera: LAN camera server listening on %s:%s (LAN IP %s)',
        state.server.host ?? config.bindHost,
        state.server.port,
        state.server.lanIp ?? 'unknown — set lanIpOverride when detection fails',
      );
      if (state.server.warning) log.warn('dsh-camera: %s', state.server.warning);
    } catch (error) {
      state.serverError = error?.message ?? String(error);
      log.error('dsh-camera: LAN camera server failed to start: %s', state.serverError);
    }
  } else {
    state.serverError = 'dsh-camera is disabled in configuration.';
  }

  state.rpc = installRpc({
    ctx,
    tokens,
    injector,
    serverRef: () => state.server,
    serverErrorRef: () => state.serverError,
    config,
    version,
    log,
  });
  if (state.rpc.available) {
    log.info('dsh-camera: RPC channel is mounted at /dsh-camera');
  }

  const prune = setInterval(() => {
    // TokenStore prunes expired entries internally; call the public hook when the
    // implementation provides one (kept optional so the interval is harmless).
    if (typeof tokens.prune === 'function') tokens.prune();
    void tokens.flush();
  }, PRUNE_INTERVAL_MS);
  if (typeof prune.unref === 'function') prune.unref();

  return async () => {
    clearInterval(prune);
    try {
      await state.rpc?.dispose?.();
    } catch (error) {
      log.warn('dsh-camera: RPC channel disposal failed: %s', error?.message ?? error);
    }
    try {
      await state.server?.stop?.();
    } catch (error) {
      log.warn('dsh-camera: LAN camera server stop failed: %s', error?.message ?? error);
    }
    state.server = null;
    state.rpc = null;
    log.info('dsh-camera: stopped');
  };
}

export default { name, inject, apply };
