import { Button } from "@grill/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grill/ui/empty";
import { MainWindow } from "@/features/shell/main-window";

/*
 * The call window without a call in progress (Tauri): it says so and
 * offers to start one. «Начать звонок» opens the start widget.
 */
export function NoCallScreen({
  className,
  onStartCall,
}: {
  className?: string;
  onStartCall: () => void;
}) {
  return (
    <MainWindow className={className} panelClassName="justify-center">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            <h1>Звонка нет</h1>
          </EmptyTitle>
          <EmptyDescription>
            Начните звонок, и здесь появятся расшифровка и вопросы.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={onStartCall}>Начать звонок</Button>
        </EmptyContent>
      </Empty>
    </MainWindow>
  );
}
