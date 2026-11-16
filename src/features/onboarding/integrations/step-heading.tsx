import type { ReactNode } from "react";

import { StepHeading } from "@/features/onboarding/components/step-heading";
import { cn } from "@/lib/utils";

import type { ServiceId } from "./mock";
import { ServiceTile } from "./service-logo";

/** Heading of a service step: the 48px logo tile above the step heading. */
export function ServiceStepHeading({
  className,
  description,
  service,
  title,
}: {
  className?: string;
  description: ReactNode;
  service: ServiceId;
  title: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <ServiceTile service={service} size="lg" />
      <StepHeading description={description} title={title} />
    </div>
  );
}
