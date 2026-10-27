import { LinkButton } from "../../components/LinkButton";
import { PageHeader } from "../../components/PageHeader";
import { paths } from "./paths";

/** Shown for any URL the app does not serve, or a resource that is not yours. */
export function NotFoundScreen({
  description = "La dirección que abriste no existe o ya no está disponible.",
}: {
  description?: string;
}) {
  return (
    <div className="screen-stack">
      <PageHeader title="Página no encontrada" description={description} />
      <div className="action-row">
        <LinkButton to={paths.panel}>Ir al panel principal</LinkButton>
      </div>
    </div>
  );
}
