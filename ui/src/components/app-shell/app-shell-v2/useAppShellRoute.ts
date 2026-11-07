import { useMatch, useNavigate } from "react-router-dom";

/**
 * Match the four V2 URL shapes and hoist params up. A single wildcard route
 * owns this shell so state survives every URL transition.
 */
export function useAppShellRoute() {
  const navigate = useNavigate();
  const matchProjectChat = useMatch("/p/:projectName/c/:sessionId");
  const matchProject = useMatch("/p/:projectName");
  const matchLegacySession = useMatch("/session/:sessionId");
  const projectNameParam = matchProjectChat?.params.projectName ?? matchProject?.params.projectName ?? undefined;
  const sessionId = matchProjectChat?.params.sessionId ?? matchLegacySession?.params.sessionId ?? undefined;
  return { navigate, projectNameParam, sessionId };
}
