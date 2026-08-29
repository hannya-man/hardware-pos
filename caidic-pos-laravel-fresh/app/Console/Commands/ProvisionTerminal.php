<?php

namespace App\Console\Commands;

use App\Models\Terminal;
use Illuminate\Console\Command;

class ProvisionTerminal extends Command
{
    protected $signature = 'terminal:provision {name : e.g. "Front counter"}';
    protected $description = 'Register a new physical POS terminal and print its one-time API key';

    public function handle(): int
    {
        $result = Terminal::provision($this->argument('name'));

        $this->info("Terminal '{$result['terminal']->name}' provisioned.");
        $this->newLine();
        $this->line('API key (shown once, not recoverable — enter it into the terminal\'s one-time setup screen):');
        $this->warn($result['raw_key']);

        return self::SUCCESS;
    }
}
