import { Link, type LinkProps } from "react-router";

/** A navigation link that looks like the app's buttons. */
export function LinkButton({
  variant = "primary",
  className,
  ...props
}: LinkProps & { variant?: "primary" | "secondary" }) {
  const classes = [
    "link-button",
    variant === "secondary" ? "is-secondary" : "",
  ];
  return (
    <Link
      {...props}
      className={[...classes, className].filter(Boolean).join(" ")}
    />
  );
}
