const FOLLOW_THRESHOLD_PX = 80;

export function shouldFollowTimeline({
  scrollTop,
  scrollHeight,
  clientHeight,
}: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  return scrollHeight - scrollTop - clientHeight <= FOLLOW_THRESHOLD_PX;
}
