import { memo, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { Message } from '../lib/types';

function TaskProgress({ message }: { message: Message }) {
  const [mountedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.floor((now - (message.startedAt || mountedAt)) / 1000));
  const elapsed = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return <div className="task-progress">
    <div className="message-progress"><LoaderCircle size={14} className="spin"/><span title={message.progress}>{message.progress || '正在处理…'}</span></div>
    <small aria-live="off">已用时 {elapsed}{seconds >= 20 ? ' · 可随时停止，缩小范围后重试' : ''}</small>
  </div>;
}

export default memo(TaskProgress);
