/**
 * Normalize Express 5 wildcard route parameter (`{*splat}`) into a single path
 * string. In Express 5, `req.params.splat` may be either a string or an array of
 * path segments depending on the matched route.
 *
 * @param {import("express").Request} req
 * @returns {string}
 */
export function getSplatPath(req) {
  const splat = req.params.splat;
  if (Array.isArray(splat)) {
    return splat.join("/");
  }
  return splat ?? "";
}
