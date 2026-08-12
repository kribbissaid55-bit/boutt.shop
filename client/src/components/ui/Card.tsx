import clsx from 'clsx';

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={clsx('rounded-xl border border-gray-200 bg-white shadow-sm', className)}>{children}</div>;
}

export function CardHeader({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-gray-100 p-4">
      <h3 className="text-base font-semibold text-gray-800">{children}</h3>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={clsx('p-4', className)}>{children}</div>;
}
