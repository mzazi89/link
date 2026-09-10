import LinkStation from '@/components/LinkStation'

/**
 * The whole page is one client component.
 *
 * Its header carries a live bot online/offline pill, so the status fetch has to
 * own that part of the tree. Keeping the shell on the server and the pill on the
 * client would mean two components disagreeing about whether the bot is up —
 * which matters here, because pairing cannot work while it is down.
 *
 * Same shape quartzxd uses for the same reason.
 */
export default function Page() {
  return <LinkStation />
}
