"use client";

import Link from "next/link";
import { Token } from "@/lib/constants";
import { TOKEN_LIST_DEFAULT } from "@/lib/constants";

export default function Coins() {
  const coins = TOKEN_LIST_DEFAULT.sort((a: Token, b: Token) =>
    a.name.localeCompare(b.name)
  );

  return (
    <section className="w-full py-12 md:py-24 lg:py-32">
      <div className="flex flex-col items-center justify-center px-4 md:px-6 space-y-4">
        <h1 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl lg:text-6xl/none">
          Coins
        </h1>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 w-full max-w-4xl">
          {coins.map((coin: Token) => (
            <Link key={coin.id} href={`/coins/${coin.id}`} className="border rounded-lg p-4 hover:shadow-md transition">
              <img src={coin.logo} alt={coin.name} className="w-10 h-10 mb-2" />
              <p className="font-semibold">{coin.name}</p>
              <p className="text-sm text-gray-500">{coin.symbol}</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
