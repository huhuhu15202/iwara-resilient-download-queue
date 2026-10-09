import com.iwara.local.Fingerprints;
import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Arrays;

public class FingerprintTest {
    public static void main(String[] args) throws Exception {
        byte[] data = new byte[1024*1024]; Arrays.fill(data, (byte)55);
        String first = Fingerprints.full(() -> new ByteArrayInputStream(data), () -> false);
        String sample = Fingerprints.sample(() -> new ByteArrayInputStream(data), data.length, () -> false);
        data[200000] = 88;
        if (first.equals(Fingerprints.full(() -> new ByteArrayInputStream(data), () -> false))) throw new AssertionError("Full digest failed");
        if (!sample.equals(Fingerprints.sample(() -> new ByteArrayInputStream(data), data.length, () -> false))) throw new AssertionError("Sample fixture failed");
        try { Fingerprints.full(() -> new ByteArrayInputStream(data), () -> true); throw new AssertionError("Cancellation failed"); } catch (InterruptedException expected) {}
        byte[] fixture = Files.readAllBytes(Paths.get(args[0]));
        if (!Fingerprints.sample(() -> new ByteArrayInputStream(fixture),fixture.length,() -> false).equals(args[1])) throw new AssertionError("Node/Java sample mismatch");
        if (!Fingerprints.full(() -> new ByteArrayInputStream(fixture),() -> false).equals(args[2])) throw new AssertionError("Node/Java full mismatch");
        System.out.println("Java fingerprints: rename-independent, full-hash confirmation, cancellation, Node/Java parity PASS");
    }
}
