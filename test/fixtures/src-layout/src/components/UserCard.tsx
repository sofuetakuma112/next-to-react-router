import Link from 'next/link';
import { useRouter } from 'next/router';

export default function UserCard({ name }: { name: string }) {
    const router = useRouter();
    const active = router.pathname === '/users/[id]';

    return (
        <p className="user" data-active={active}>
            <Link href="/">{name}</Link>
        </p>
    );
}
