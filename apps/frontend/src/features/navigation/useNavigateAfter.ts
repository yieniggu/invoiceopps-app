import {
  useLocation,
  useNavigate,
  type NavigateOptions,
  type To,
} from "react-router";

/**
 * `navigate` for the end of an asynchronous action: it only moves the person
 * if they are still where the action started. Somebody who followed a link
 * while the action was finishing keeps the place they chose instead of being
 * pulled back to the action's destination.
 */
export function useNavigateAfter() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (to: To, options?: NavigateOptions): boolean => {
    // `window.location` is already the new place while the router is still
    // rendering a transition to it.
    if (window.location.pathname !== pathname) return false;
    void navigate(to, options);
    return true;
  };
}
