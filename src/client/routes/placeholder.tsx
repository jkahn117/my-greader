/** @jsxImportSource react */
import { Card, CardContent } from "../components/ui/card";

/** Interim placeholder for routes landing in later migration tickets. */
export function PlaceholderPage({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <Card>
      <CardContent className="py-10 text-center">
        <h1 className="text-base font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      </CardContent>
    </Card>
  );
}
