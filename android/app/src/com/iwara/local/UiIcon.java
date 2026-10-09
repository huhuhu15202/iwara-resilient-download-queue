package com.iwara.local;

import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.drawable.Drawable;

/** Small original line icons, independent of fonts or external assets. */
public final class UiIcon extends Drawable {
    private final String name; private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG); private final int size;
    public UiIcon(String name, int color, int size) { this.name = name; this.size = size; paint.setColor(color); paint.setStrokeWidth(1.8f); paint.setStrokeCap(Paint.Cap.ROUND); paint.setStrokeJoin(Paint.Join.ROUND); }
    private void line(Canvas c, float x, float y, float a, float b) { c.drawLine(x,y,a,b,paint); }
    private void lines(Canvas c, float... points) { Path p = new Path(); p.moveTo(points[0],points[1]); for(int i=2;i<points.length;i+=2)p.lineTo(points[i],points[i+1]); c.drawPath(p,paint); }
    @Override public void draw(Canvas canvas) {
        int checkpoint = canvas.save(); canvas.translate(getBounds().left,getBounds().top); canvas.scale(getBounds().width()/24f,getBounds().height()/24f); paint.setStyle(Paint.Style.STROKE);
        switch(name) {
            case "search": canvas.drawCircle(10.5f,10.5f,6.5f,paint); line(canvas,15.5f,15.5f,21,21); break;
            case "filter": line(canvas,4,6,20,6); line(canvas,7,12,17,12); line(canvas,10,18,14,18); break;
            case "library": canvas.drawRoundRect(3,3,10,10,1.8f,1.8f,paint);canvas.drawRoundRect(14,3,21,10,1.8f,1.8f,paint);canvas.drawRoundRect(3,14,10,21,1.8f,1.8f,paint);canvas.drawRoundRect(14,14,21,21,1.8f,1.8f,paint);break;
            case "shuffle": lines(canvas,3,6,6,6,18,18,21,18);lines(canvas,18,15,21,18,18,21);lines(canvas,3,18,6,18,10,14);lines(canvas,14,10,18,6,21,6);lines(canvas,18,3,21,6,18,9);break;
            case "manage": line(canvas,4,6,20,6);line(canvas,4,12,20,12);line(canvas,4,18,20,18);paint.setStyle(Paint.Style.FILL);canvas.drawCircle(8,6,2.5f,paint);canvas.drawCircle(16,12,2.5f,paint);canvas.drawCircle(10,18,2.5f,paint);break;
            case "play": paint.setStyle(Paint.Style.FILL);Path triangle=new Path();triangle.moveTo(8,4);triangle.lineTo(20,12);triangle.lineTo(8,20);triangle.close();canvas.drawPath(triangle,paint);break;
            case "sync": lines(canvas,19,4,21,8,17,8);canvas.drawArc(3,3,21,21,195,140,false,paint);lines(canvas,5,20,3,16,7,16);canvas.drawArc(3,3,21,21,15,140,false,paint);break;
            case "folder": lines(canvas,3,7,3,20,21,20,21,7,12,7,10,4,3,4,3,7);break;
            case "link": canvas.drawRoundRect(3,4,12,20,2,2,paint);lines(canvas,15,8,19,8,21,10,21,14,19,16,15,16);line(canvas,8,12,17,12);break;
            case "pause": line(canvas,8,5,8,19);line(canvas,16,5,16,19);break;
            case "import": lines(canvas,4,15,4,20,20,20,20,15);line(canvas,12,3,12,15);lines(canvas,7,10,12,15,17,10);break;
            case "close": line(canvas,6,6,18,18);line(canvas,18,6,6,18);break;
            case "back": lines(canvas,14,4,6,12,14,20);line(canvas,6,12,21,12);break;
            default: canvas.drawCircle(12,12,8,paint);
        }
        canvas.restoreToCount(checkpoint);
    }
    @Override public void setAlpha(int alpha){paint.setAlpha(alpha);invalidateSelf();}
    @Override public void setColorFilter(ColorFilter filter){paint.setColorFilter(filter);invalidateSelf();}
    @Override public int getOpacity(){return PixelFormat.TRANSLUCENT;}
    @Override public int getIntrinsicWidth(){return size;}
    @Override public int getIntrinsicHeight(){return size;}
}
