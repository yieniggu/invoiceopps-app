import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";
import type { ReactNode } from "react";

export function BackLink({
  to,
  children,
}: {
  to: string;
  children: ReactNode;
}) {
  return (
    <Link to={to} className="back-link">
      <ArrowLeft aria-hidden="true" focusable="false" size={16} />
      {children}
    </Link>
  );
}
