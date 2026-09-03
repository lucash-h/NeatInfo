import { useApp } from '../AppContext';

export default function Toast() {
  const { toastMsg } = useApp();
  if (!toastMsg) return null;
  return <div className="toast">{toastMsg}</div>;
}
