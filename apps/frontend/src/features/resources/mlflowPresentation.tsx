type ResourceLinkProps = { url?: string | null; children: string };

export function ResourceLink({ url, children }: ResourceLinkProps) {
  let href: string | undefined;
  try {
    if (url) {
      const parsed = new URL(url);
      if (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        !parsed.username &&
        !parsed.password
      )
        href = parsed.href;
    }
  } catch {
    // Missing or malformed provider links must never become navigation targets.
  }
  return (
    <div>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          {children}
        </a>
      ) : (
        <>
          <span>{children}</span>
          <small className="block text-slate-600">Enlace no disponible</small>
        </>
      )}
    </div>
  );
}

export function snapshotDate(value: string | null | undefined) {
  if (!value) return "Fecha no disponible";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Fecha no disponible"
    : date.toLocaleString("es-CL");
}

export function referenceType(value: string) {
  switch (value) {
    case "ml-experiment":
      return "Experimento ML";
    case "ml-model":
      return "Modelo ML";
    default:
      return "Tipo no disponible";
  }
}
