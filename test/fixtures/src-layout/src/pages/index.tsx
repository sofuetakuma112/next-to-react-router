import Link from 'next/link';

export default function Home() {
    return (
        <main>
            <h1>Users</h1>
            <Link href="/users/7">User 7</Link>
        </main>
    );
}
