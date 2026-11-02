import Link from "next/link";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import type { PersonSummary } from "../mock";
import { LevelMeter } from "./level-meter";

/*
 * Person of the client on the project page: a white card with the avatar,
 * name and role, the "1 правка" pill when the agent suggests an edit, two
 * small scales and how to ask them. The whole card links to the profile.
 */
export function PersonCard({
  className,
  href = "#",
  person,
}: {
  className?: string;
  href?: string;
  person: PersonSummary;
}) {
  return (
    <Link
      className={cn(
        "bg-background shadow-card hover:shadow-float focus-visible:focus-ring flex flex-col gap-3.5 rounded-md p-5 transition-shadow",
        className
      )}
      href={href}
    >
      <span className="flex items-center gap-3">
        <PersonAvatar initials={person.initials} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-foreground text-lg font-medium">
            {person.name}
          </span>
          <span className="text-muted-foreground text-sm">{person.role}</span>
        </span>
        {person.edits ? (
          <Badge className="text-xs" size="sm" variant="waiting">
            <span
              aria-hidden="true"
              className="bg-accent size-1.5 shrink-0 rounded-full"
            />
            {person.edits}
          </Badge>
        ) : null}
      </span>
      <span className="flex gap-6">
        <PersonScale label="В технике" level={person.tech} />
        <PersonScale label="В проекте" level={person.project} />
      </span>
      <span className="text-muted-foreground text-base">{person.howToAsk}</span>
    </Link>
  );
}

function PersonScale({ label, level }: { label: string; level: number }) {
  return (
    <span className="flex flex-col gap-1.5">
      <span aria-hidden="true" className="text-muted-foreground text-xs">
        {label}
      </span>
      <LevelMeter label={label} level={level} />
    </span>
  );
}

/** Round avatar with initials on the surface gray: 40 in lists, 64 in the profile. */
export function PersonAvatar({
  className,
  initials,
  size = "md",
}: {
  className?: string;
  initials: string;
  size?: "md" | "lg";
}) {
  return (
    <Avatar
      aria-hidden="true"
      className={cn(size === "lg" ? "size-16" : "size-10", className)}
    >
      <AvatarFallback
        className={cn("bg-surface", size === "lg" ? "text-xl" : "text-base")}
      >
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}
