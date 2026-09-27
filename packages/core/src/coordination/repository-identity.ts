/**
 * Which repository a checkout is, named by its remote, so two clones on two machines are
 * one repository and two projects that share a folder name are two. The folder name alone
 * made `api` on one laptop and `api` on another collide whatever they were.
 */

/**
 * `git@github.com:Acme/API.git` and `https://github.com/acme/api` as `github.com/acme/api`.
 * Undefined for anything that is not a remote, which a register reads as any repository.
 */
export function repositoryIdentity(url: string | null | undefined): string | undefined {
  if (url === null || url === undefined) return undefined;
  const text = url.trim();
  // scp form, `user@host:path`, before the URL form, since it has no scheme to parse.
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text);
  const found =
    scp === null
      ? /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(text)
      : scp;
  if (found === null) return undefined;
  const [, host, path] = found;
  if (host === undefined || path === undefined) return undefined;
  const clean = path.replace(/\.git\/?$/i, '').replace(/\/+$/, '');
  if (clean === '') return undefined;
  return `${host}/${clean}`.toLowerCase();
}

/**
 * Whether two named repositories are one, where both were named. A side that could not
 * say, an older runtime or a checkout with no remote, is read as any repository, since
 * failing to separate two repositories costs a wait and failing to join one costs work.
 */
export function sameRepository(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return true;
  return a === b;
}
