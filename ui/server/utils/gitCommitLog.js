/**
 * Pure parser for the single-call `git log --stat` output that backs the
 * `/api/git/commits` endpoint (#534).
 *
 * Extracted to a dependency-free leaf module so it can be unit-tested in
 * isolation (importing `routes/git.js` pulls in express + the gateway bridge)
 * and so `routes/git.js` does not grow past its architecture-baseline budget.
 */

/**
 * A commit header line produced by `--pretty=format:%H|%an|%ae|%ad|%s`: a full
 * SHA-1/SHA-256 hash followed by `|`. Anchored so a stat/summary line can never
 * be mistaken for a header. `{40,64}` covers both SHA-1 (40) and SHA-256 (64).
 */
const COMMIT_HEADER_RE = /^[0-9a-f]{40,64}\|/;
/** The `--stat` summary line, e.g. `2 files changed, 3 insertions(+), 1 deletion(-)`. */
const STAT_SUMMARY_RE = /\d+ files? changed/;

/**
 * Parse `git log --pretty=format:%H|%an|%ae|%ad|%s --date=iso-strict --stat`
 * output into commit objects with a `stats` summary line (#534).
 *
 * Splitting is by the **header regex**, not by blank lines: a merge commit's
 * `--stat` block is entirely absent *and* is not followed by a blank line, so
 * blank-line chunking would splice the next commit's stat onto the merge. Within
 * a block we take the last line matching {@link STAT_SUMMARY_RE}; when there is
 * none (merge commit, or an object git could not stat) `stats` is `""` — exactly
 * what the old per-commit `git show --stat --format=` loop returned.
 *
 * @param {string} logOutput raw stdout of the single `git log --stat` call
 * @returns {{hash:string,author:string,email:string,date:string,message:string,stats:string}[]}
 */
export function parseCommitLogWithStats(logOutput) {
  const commits = [];
  let header = null;
  let statLines = [];

  const flush = () => {
    if (header === null) return;
    let stats = "";
    for (const line of statLines) {
      if (STAT_SUMMARY_RE.test(line)) stats = line.trim();
    }
    const [hash, author, email, date, ...messageParts] = header.split("|");
    commits.push({ hash, author, email, date, message: messageParts.join("|"), stats });
  };

  for (const line of String(logOutput ?? "").split("\n")) {
    if (COMMIT_HEADER_RE.test(line)) {
      flush();
      header = line;
      statLines = [];
    } else if (header !== null) {
      statLines.push(line);
    }
  }
  flush();

  return commits;
}
