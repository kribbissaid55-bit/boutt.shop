import { useEffect, useRef, useState } from 'react';
import { Upload, Trash2, FileText, Music, Video } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { PageHeader } from '../components/ui/PageHeader';
import { Card, CardBody } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Empty } from '../components/ui/Empty';

type MediaFile = { id: string; name: string; type: string; mimeType: string; sizeBytes: number; createdAt: string };

const fmtSize = (b: number) => b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;

export function MediaPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<MediaFile[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => api.get<MediaFile[]>('/media').then(setItems);
  useEffect(() => { load(); }, []);

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      await api.upload('/media', file);
      toast.success(t.media.uploaded);
      load();
    } catch (err: any) {
      toast.error(err?.message ?? t.app.error);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (id: string) => {
    if (!confirm(t.media.deleteConfirm)) return;
    try {
      await api.delete(`/media/${id}`);
      await load();
      toast.success(t.app.saved);
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    }
  };

  const Icon = (type: string) => {
    if (type === 'audio') return <Music />;
    if (type === 'video') return <Video />;
    return <FileText />;
  };

  return (
    <>
      <PageHeader
        title={t.media.title}
        actions={
          <>
            <input ref={fileRef} type="file" className="hidden" onChange={onUpload}
              accept="audio/*,image/*,video/*,.mp3,.m4a,.ogg,.opus,.wav,.aac,.amr,.flac,.aiff,.jpg,.jpeg,.png,.webp,.gif,.mp4,.mov,.webm,.3gp,.pdf,.doc,.docx" />
            <Button onClick={() => fileRef.current?.click()} loading={busy}><Upload size={16} />{t.media.upload}</Button>
          </>
        }
      />
      {items.length === 0 ? (
        <Card><Empty /></Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-5">
          {items.map((m) => (
            <Card key={m.id}>
              <CardBody className="p-2">
                {m.type === 'image' ? (
                  <img src={`/api/media/${m.id}/raw`} className="h-32 w-full rounded-lg object-cover" />
                ) : m.type === 'video' ? (
                  <video src={`/api/media/${m.id}/raw`} controls className="h-32 w-full rounded-lg bg-black" />
                ) : m.type === 'audio' ? (
                  <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-lg bg-gray-50">
                    <Music className="text-gray-400" />
                    <audio src={`/api/media/${m.id}/raw`} controls className="w-full" />
                  </div>
                ) : (
                  <div className="flex h-32 items-center justify-center rounded-lg bg-gray-50 text-gray-400">{Icon(m.type)}</div>
                )}
                <div className="mt-2 truncate text-xs font-medium" title={m.name}>{m.name}</div>
                <div className="flex items-center justify-between text-[10px] text-gray-400">
                  <span>{fmtSize(m.sizeBytes)}</span>
                  <button onClick={() => remove(m.id)} className="rounded p-1 text-red-500 hover:bg-red-50"><Trash2 size={12} /></button>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
